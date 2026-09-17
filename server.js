require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const path = require('path');
const https = require('https');
const { LAWD_CODES } = require('./lawdCodes');

// PC의 백신/보안 프로그램이나 사내망이 HTTPS를 가로채 검사(SSL 인터셉션)하면, 브라우저는
// 그 프로그램의 인증서를 이미 신뢰해도 Node.js는 몰라서 SELF_SIGNED_CERT_IN_CHAIN으로 막힌다.
// 국토부 API(신뢰 가능한 정부 도메인) 호출에 한해서만 그 경우 인증서 검증을 우회해 재시도한다.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

async function getWithTlsFallback(url, config) {
  try {
    return await axios.get(url, config);
  } catch (err) {
    const isSelfSignedIssue = err.code === 'SELF_SIGNED_CERT_IN_CHAIN'
      || /self-signed certificate/i.test(err.message || '');
    if (!isSelfSignedIssue) throw err;
    console.warn('[molit/trades] TLS 체인에서 self-signed 인증서 감지(백신/사내망 SSL 검사 등으로 흔함). ' +
      '이 요청에 한해 인증서 검증을 우회해 재시도합니다.');
    return await axios.get(url, { ...config, httpsAgent: insecureAgent });
  }
}

// 카카오 로컬 API 실패 사유를 한국어로 알려준다.
function friendlyKakaoError(status, message) {
  if (status === 401) {
    return '카카오 REST API 키가 유효하지 않습니다. developers.kakao.com에서 REST API 키(JavaScript 키 아님)를 확인하세요.';
  }
  if (status === 403) {
    return '카카오 API 접근이 거부되었습니다. 앱 설정에서 "카카오맵(Local)" 서비스가 활성화되어 있는지 확인하세요.';
  }
  if (status === 429) {
    return '카카오 API 호출 한도를 초과했습니다. 잠시 후 다시 시도하세요.';
  }
  return message || `카카오 API 오류 (HTTP ${status})`;
}

const app = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY; // 브라우저(Maps JS SDK, 지도 렌더링)용
// 카카오 로컬(Local) API용 REST 키. 지도에 쓰는 JavaScript 키와는 다른 키이며,
// developers.kakao.com > 내 애플리케이션 > 요약 정보 에서 확인 가능. 결제(빌링) 등록이
// 필요 없고 좌표<->주소 변환을 서버에서 호출한다.
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const MOLIT_API_KEY = process.env.MOLIT_API_KEY;

const kakaoHeaders = { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` };

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------------------------------------------------
// 1) 클라이언트가 구글맵 JS SDK를 로드할 때 필요한 "공개" 키만 내려준다.
//    (국토부 인증키는 절대 여기 포함시키지 않는다)
// -----------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({ googleMapsApiKey: GOOGLE_MAPS_API_KEY || null });
});

// -----------------------------------------------------------------------
// 2) 좌표 -> 시군구코드(LAWD_CD) 역변환
//    카카오 로컬 API의 coord2regioncode로 법정동 정보를 직접 받는다.
//    응답의 10자리 법정동코드 앞 5자리가 국토부 API가 쓰는 시군구코드(LAWD_CD)와 동일하다.
// -----------------------------------------------------------------------
app.get('/api/geocode/reverse', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) {
    return res.status(400).json({ error: 'lat, lng 파라미터가 필요합니다.' });
  }
  if (!KAKAO_REST_API_KEY) {
    return res.status(500).json({ error: 'KAKAO_REST_API_KEY가 서버에 설정되지 않았습니다.' });
  }

  try {
    const { data } = await axios.get('https://dapi.kakao.com/v2/local/geo/coord2regioncode.json', {
      params: { x: lng, y: lat }, // 카카오는 x=경도, y=위도 순서
      headers: kakaoHeaders,
    });

    // region_type "B"가 법정동(국토부 API 기준), "H"는 행정동이라 용도가 다르다.
    const region = data.documents?.find(d => d.region_type === 'B');
    if (!region) {
      return res.status(404).json({ error: '해당 좌표의 법정동 정보를 찾지 못했습니다 (바다 등일 수 있습니다).' });
    }

    const lawdCd = region.code ? region.code.slice(0, 5) : null;

    res.json({
      formattedAddress: region.address_name,
      sido: region.region_1depth_name || null,
      sigungu: region.region_2depth_name || null,
      lawdCd,
      supported: !!lawdCd,
    });
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.message || err.message;
    console.error('[geocode/reverse] kakao error:', status, message);
    res.status(502).json({ error: friendlyKakaoError(status, message), detail: message });
  }
});

// -----------------------------------------------------------------------
// 3) 주소(단지명 포함) 목록 -> 좌표 배치 변환 (마커 찍기용)
//    카카오 키워드 검색(/v2/local/search/keyword.json)을 사용한다. 아파트 단지명은
//    정식 도로명주소보다 "장소 키워드"로 검색했을 때 매칭률이 훨씬 높다.
//    같은 주소가 여러 건 있을 수 있으므로 서버 메모리에 캐시해서 호출을 절약한다.
// -----------------------------------------------------------------------
const geocodeCache = new Map();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function geocodeOne(query, attempt = 1) {
  if (geocodeCache.has(query)) return geocodeCache.get(query);
  try {
    const { data } = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
      params: { query, size: 1 },
      headers: kakaoHeaders,
    });
    let result = null;
    if (data.documents?.length) {
      const doc = data.documents[0];
      result = { lat: Number(doc.y), lng: Number(doc.x) };
    } else {
      console.error('[geocodeOne] no result:', query);
    }
    geocodeCache.set(query, result);
    return result;
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.message || err.message;
    // 초당 호출 제한(429)이나 순간적인 5xx는 그냥 실패 처리하면 매물이 조용히 지도에서
    // 빠져버리니, 짧게 대기 후 최대 2번까지 재시도한다.
    const isRateLimited = status === 429 || status === 503;
    if (isRateLimited && attempt <= 2) {
      await sleep(300 * attempt);
      return geocodeOne(query, attempt + 1);
    }
    console.error('[geocodeOne]', query, status, message);
    return null;
  }
}

app.post('/api/geocode/batch', async (req, res) => {
  const { addresses } = req.body;
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({ error: 'addresses 배열이 필요합니다.' });
  }
  if (!KAKAO_REST_API_KEY) {
    return res.status(500).json({ error: 'KAKAO_REST_API_KEY가 서버에 설정되지 않았습니다.' });
  }

  const uniqueAddresses = [...new Set(addresses)];
  const CONCURRENCY = 6; // 카카오 API 한도를 고려한 안전한 동시 처리 수 (재시도 로직으로 순간 초과는 커버)
  const resultMap = {};

  for (let i = 0; i < uniqueAddresses.length; i += CONCURRENCY) {
    const batch = uniqueAddresses.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(geocodeOne));
    batch.forEach((addr, idx) => { resultMap[addr] = results[idx]; });
    if (i + CONCURRENCY < uniqueAddresses.length) await sleep(100);
  }

  res.json(resultMap);
});

// -----------------------------------------------------------------------
// 3.5) 인근 시설 여부 확인 (역세권 / 대형마트·백화점 / 공원 / 학교)
//    카카오 로컬 API의 카테고리·키워드 검색으로 좌표 주변에 해당 시설이 실제로
//    있는지 확인한다. "추가 조건" 필터가 이 결과를 근거로 매물을 좁힌다.
// -----------------------------------------------------------------------
const NEARBY_TYPE_CONFIG = {
  subway: { mode: 'category', code: 'SW8', radius: 500 },   // 지하철역
  mart:   { mode: 'category', code: 'MT1', radius: 1000 },  // 대형마트 (백화점 상당수 포함)
  school: { mode: 'category', code: 'SC4', radius: 500 },   // 학교
  park:   { mode: 'keyword', query: '공원', radius: 500 },  // 카카오 카테고리엔 "공원"이 없어 키워드 검색으로 대체
};

async function checkNearbyOne(item, cfg, attempt = 1) {
  try {
    const url = cfg.mode === 'category'
      ? 'https://dapi.kakao.com/v2/local/search/category.json'
      : 'https://dapi.kakao.com/v2/local/search/keyword.json';
    const params = cfg.mode === 'category'
      ? { category_group_code: cfg.code, x: item.lng, y: item.lat, radius: cfg.radius, sort: 'distance' }
      : { query: cfg.query, x: item.lng, y: item.lat, radius: cfg.radius, sort: 'distance' };

    const { data } = await axios.get(url, { params, headers: kakaoHeaders });
    const nearest = (data.documents || []).find(d => Number(d.distance) <= cfg.radius);
    if (!nearest) return { id: item.id, found: false };
    return {
      id: item.id,
      found: true,
      // 실제로 매칭된 시설 정보 - 프론트에서 지도에 별도 마커로 표시하는 데 사용
      facility: {
        name: nearest.place_name,
        lat: Number(nearest.y),
        lng: Number(nearest.x),
        distance: Number(nearest.distance),
      },
    };
  } catch (err) {
    const status = err.response?.status;
    // 429(초당 호출 제한)로 실패한 걸 그냥 "시설 없음"으로 처리하면, 실제로는 가까이 있는데도
    // 결과에서 빠져버려 추가조건을 걸수록 건수가 확 줄어드는 것처럼 보인다. 짧게 대기 후 재시도.
    if ((status === 429 || status === 503) && attempt <= 2) {
      await sleep(300 * attempt);
      return checkNearbyOne(item, cfg, attempt + 1);
    }
    console.error('[nearby-check]', item.id, err.response?.data || err.message);
    return { id: item.id, found: false };
  }
}

app.post('/api/nearby-check', async (req, res) => {
  const { items, type } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items 배열이 필요합니다.' });
  }
  const cfg = NEARBY_TYPE_CONFIG[type];
  if (!cfg) {
    return res.status(400).json({ error: `지원하지 않는 type입니다: ${type}` });
  }
  if (!KAKAO_REST_API_KEY) {
    return res.status(500).json({ error: 'KAKAO_REST_API_KEY가 서버에 설정되지 않았습니다.' });
  }

  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(item => checkNearbyOne(item, cfg)));
    results.push(...batchResults);
    if (i + CONCURRENCY < items.length) await sleep(100);
  }

  res.json({ type, results });
});

// -----------------------------------------------------------------------
// 4) 국토교통부 실거래 자료 프록시 - 주택유형 x 거래유형별로 API가 전부 다르다.
//    (아파트 매매만 상세자료(Dev) 버전이 있고, 나머지는 일반 버전만 제공됨)
// -----------------------------------------------------------------------
const MOLIT_DATASET = {
  apt:   { trade: 'RTMSDataSvcAptTradeDev', rent: 'RTMSDataSvcAptRent',  nameField: 'aptNm' },
  offi:  { trade: 'RTMSDataSvcOffiTrade',   rent: 'RTMSDataSvcOffiRent', nameField: 'offiNm' },
  villa: { trade: 'RTMSDataSvcRHTrade',     rent: 'RTMSDataSvcRHRent',   nameField: 'mhouseNm' },
};

// 프론트의 select-housing / select-deal 값을 내부 키로 매핑
function resolveHousingType(v) {
  if (v === '오피스텔') return 'offi';
  if (v === '빌라' || v === '연립다세대') return 'villa';
  return 'apt';
}
function resolveDealCategory(v) {
  return v === '매매' ? 'trade' : 'rent'; // 전세/월세는 같은 API를 쓰고 monthlyRent로 구분한다
}

// data.go.kr 공식 에러코드 안내(오픈API 상세 페이지 "오픈API 에러코드 안내" 표 기준).
// 01/05/23은 "잠시 후 다시 호출"이 공식 권장 대응이라 자동 재시도 대상으로 분류한다.
const MOLIT_ERROR_GUIDE = {
  '01': { message: 'GW 내부 처리 중 일시적 오류(APPLICATION_ERROR)', transient: true },
  '04': { message: '허용되지 않은 HTTP 요청이거나 기관 API 응답 처리에 실패했습니다(HTTP_ERROR).', transient: false },
  '05': { message: '기관 API 연결 실패 또는 응답 시간 초과(SERVICETIMEOUT_ERROR)', transient: true },
  '10': { message: '요청 파라미터 값/형식이 올바르지 않습니다(INVALID_REQUEST_PARAMETER_ERROR).', transient: false },
  '12': { message: '요청한 오픈API 서비스가 존재하지 않거나 폐기되었습니다(NO_OPENAPI_SERVICE_ERROR). 호출 URL을 확인하세요.', transient: false },
  '20': { message: '인증키 누락 또는 접근 권한이 없습니다. 공공데이터포털에서 이 API의 활용신청/승인 상태를 확인하세요.', transient: false },
  '22': { message: '일일 호출 허용량을 초과했습니다.', transient: false },
  '23': { message: '초당 호출 허용량을 초과했습니다.', transient: true },
  '29': { message: '차단된 IP에서의 호출입니다.', transient: false },
  '30': { message: '등록되지 않은 API 인증키입니다. 키 값과 활용신청 완료 여부를 확인하세요.', transient: false },
  '31': { message: 'API 인증키 사용 기한이 만료되었습니다.', transient: false },
};

function decorateMolitError(code, rawMsg) {
  const guide = MOLIT_ERROR_GUIDE[code];
  return {
    message: guide ? `${guide.message} (코드 ${code})` : (rawMsg || `알 수 없는 오류 (코드 ${code})`),
    transient: guide ? guide.transient : false,
  };
}

// 한 번의 국토부 API 호출 + XML 파싱 + 에러 판별. 실패 시 { transient, message, resultCode } 형태의
// 에러를 throw 한다 (transient=true면 호출부에서 재시도).
// housingType: 'apt' | 'offi' | 'villa', dealCategory: 'trade' | 'rent'
async function fetchMolitTradesOnce(lawdCd, dealYmd, housingType = 'apt', dealCategory = 'trade') {
  const dataset = MOLIT_DATASET[housingType] || MOLIT_DATASET.apt;
  const group = dealCategory === 'rent' ? dataset.rent : dataset.trade;
  const url = `https://apis.data.go.kr/1613000/${group}/get${group}`;

  let xmlData;
  try {
    const resp = await getWithTlsFallback(url, {
      params: {
        serviceKey: MOLIT_API_KEY,
        LAWD_CD: lawdCd,
        DEAL_YMD: dealYmd,
        numOfRows: 500, // 시군구+월 단위라 이 정도면 충분하고, 과도한 응답 크기로 인한 GW 오류 가능성을 줄인다
        pageNo: 1,
      },
      timeout: 15000,
      responseType: 'text',
      transformResponse: [(d) => d], // xml2js에 원문 그대로 넘기기 위해 axios의 자동 JSON 파싱을 끈다
    });
    xmlData = resp.data;
  } catch (err) {
    const status = err.response?.status;
    const bodySnippet = err.response?.data ? String(err.response.data).slice(0, 500) : null;
    // HTTP 에러 상태로 왔어도 본문이 XML 공통 에러 형식이면 그 안의 코드로 재분류한다.
    if (bodySnippet && /<returnReasonCode>(\d+)</.test(bodySnippet)) {
      const code = bodySnippet.match(/<returnReasonCode>(\d+)</)[1];
      throw { ...decorateMolitError(code), resultCode: code };
    }
    const netTransient = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code);
    throw {
      transient: netTransient,
      message: [status ? `HTTP ${status}` : null, err.code, bodySnippet, !status && !bodySnippet ? err.message : null]
        .filter(Boolean).join(' | '),
    };
  }

  let parsed;
  try {
    parsed = await xml2js.parseStringPromise(xmlData, { explicitArray: false, trim: true });
  } catch (parseErr) {
    console.error('[molit/trades] XML 파싱 실패. 원문:', String(xmlData).slice(0, 500));
    throw { transient: false, message: '국토부 API가 예상치 못한 형식으로 응답했습니다 (XML이 아님).', rawSnippet: String(xmlData).slice(0, 500) };
  }

  // 정상 응답은 <response><header>...</header></response> 구조지만, 서비스키 오류 등은
  // <OpenAPI_ServiceResponse><cmmMsgHeader>...</cmmMsgHeader></OpenAPI_ServiceResponse> 로 온다.
  const commonError = parsed?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (commonError) {
    const code = commonError.returnReasonCode;
    throw { ...decorateMolitError(code, commonError.errMsg || commonError.returnAuthMsg), resultCode: code };
  }

  const header = parsed?.response?.header;
  const isSuccess = !header || !header.resultCode || ['00', '000', '0'].includes(header.resultCode);
  if (!isSuccess) {
    throw { transient: false, message: '국토부 API 오류: ' + header.resultMsg, resultCode: header.resultCode };
  }

  let items = parsed?.response?.body?.items?.item || [];
  if (!Array.isArray(items)) items = [items]; // 결과 1건일 때 객체로 오는 경우 대비

  return items.filter(Boolean).map((item) => {
    const excluUseAr = parseFloat(item.excluUseAr) || 0;
    // 건물명 필드가 유형별로 다르다(아파트=aptNm, 오피스텔=offiNm, 연립다세대=mhouseNm).
    // 내부적으로는 계속 aptNm이라는 이름으로 통일해서 기존 코드(추정치 매칭 등)를 그대로 쓴다.
    const buildingName = (item[dataset.nameField] || '').trim();

    const base = {
      aptNm: buildingName,
      umdNm: (item.umdNm || '').trim(),
      jibun: (item.jibun || '').trim(),
      excluUseAr,
      pyeong: Math.round((excluUseAr / 3.3058) * 10) / 10,
      dealYear: item.dealYear,
      dealMonth: item.dealMonth,
      dealDay: item.dealDay,
      floor: item.floor,
      buildYear: item.buildYear,
      dealingGbn: item.dealingGbn || '',
      estateAgentSggNm: item.estateAgentSggNm || '',
      dealCategory,
    };

    if (dealCategory === 'rent') {
      const depositManwon = parseInt(String(item.deposit).replace(/,/g, ''), 10) || 0;
      const monthlyRentManwon = parseInt(String(item.monthlyRent).replace(/,/g, ''), 10) || 0;
      return {
        ...base,
        // 필터/카드 표시 로직을 매매와 공유하기 위해 "가격"에 해당하는 값을 보증금으로 채운다.
        dealAmountManwon: depositManwon,
        dealAmountEok: Math.round((depositManwon / 10000) * 100) / 100,
        monthlyRentManwon,
        isJeonse: monthlyRentManwon === 0,
      };
    }

    const dealAmountManwon = parseInt(String(item.dealAmount).replace(/,/g, ''), 10) || 0;
    return {
      ...base,
      dealAmountManwon,
      dealAmountEok: Math.round((dealAmountManwon / 10000) * 100) / 100,
    };
  });
}

// 재시도까지 포함한 단일 월 조회. 실패하면 마지막 에러를 throw.
async function fetchMolitTradesRetried(lawdCd, dealYmd, housingType = 'apt', dealCategory = 'trade') {
  const MAX_ATTEMPTS = 3;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchMolitTradesOnce(lawdCd, dealYmd, housingType, dealCategory);
    } catch (err) {
      lastError = err;
      console.error(`[molit] ${dealYmd} 시도 ${attempt}/${MAX_ATTEMPTS} 실패:`, err.resultCode || '', err.message);
      if (err.transient && attempt < MAX_ATTEMPTS) {
        await sleep(800 * attempt);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

// "YYYYMM" 기준으로 n개월 전의 "YYYYMM"을 계산.
function shiftYm(dealYmd, monthsBack) {
  const y = parseInt(dealYmd.slice(0, 4), 10);
  const m = parseInt(dealYmd.slice(4, 6), 10);
  const d = new Date(y, m - 1 - monthsBack, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

app.get('/api/molit/trades', async (req, res) => {
  const { lawdCd, dealYmd } = req.query;
  const housingType = req.query.housingType || 'apt';
  const dealCategory = req.query.dealCategory || 'trade';

  if (!lawdCd || !/^\d{5}$/.test(lawdCd)) {
    return res.status(400).json({ error: 'lawdCd(5자리 시군구코드)가 필요합니다.' });
  }
  if (!dealYmd || !/^\d{6}$/.test(dealYmd)) {
    return res.status(400).json({ error: 'dealYmd(YYYYMM)가 필요합니다.' });
  }
  if (!MOLIT_API_KEY) {
    return res.status(500).json({ error: 'MOLIT_API_KEY가 서버에 설정되지 않았습니다.' });
  }

  try {
    const trades = await fetchMolitTradesRetried(lawdCd, dealYmd, housingType, dealCategory);
    res.json({ count: trades.length, lawdCd, dealYmd, trades });
  } catch (lastError) {
    res.status(502).json({
      error: '국토부 실거래가 API 호출 실패',
      detail: lastError.message,
      resultCode: lastError.resultCode,
    });
  }
});

// -----------------------------------------------------------------------
// 4.5) 실거래 + "추정 시세" 병합 조회
//    - 목표 계약년월(dealYmd)에 실거래가 있는 단지는 그대로 실거래로 보여준다.
//    - 목표 월에 거래가 없던 단지는, 과거 몇 개월(lookback) 안에서 그 단지의 가장 최근
//      실거래를 찾아 "추정 시세"로 대신 보여준다 (실제 계약월을 그대로 표기해 구분).
//    - 공식 "공동주택 공시가격" 실시간 조회 API는 존재하지 않아(연 1회 대용량 파일 또는
//      좌표 기반 공간정보 API뿐) 이 방식으로 대체한다.
// -----------------------------------------------------------------------
app.get('/api/molit/trades-with-estimate', async (req, res) => {
  const { lawdCd, dealYmd } = req.query;
  const housingType = req.query.housingType || 'apt';
  const dealCategory = req.query.dealCategory || 'trade';
  const lookback = Math.min(parseInt(req.query.lookback, 10) || 6, 12); // 과도한 호출 방지, 최대 12개월

  if (!lawdCd || !/^\d{5}$/.test(lawdCd)) {
    return res.status(400).json({ error: 'lawdCd(5자리 시군구코드)가 필요합니다.' });
  }
  if (!dealYmd || !/^\d{6}$/.test(dealYmd)) {
    return res.status(400).json({ error: 'dealYmd(YYYYMM)가 필요합니다.' });
  }
  if (!MOLIT_API_KEY) {
    return res.status(500).json({ error: 'MOLIT_API_KEY가 서버에 설정되지 않았습니다.' });
  }

  // 1) 목표 월 조회 (여기서 실패하면 전체를 실패로 처리 - 사용자가 보는 기준월이라 중요함)
  let targetTrades;
  try {
    targetTrades = await fetchMolitTradesRetried(lawdCd, dealYmd, housingType, dealCategory);
  } catch (lastError) {
    return res.status(502).json({
      error: '국토부 실거래가 API 호출 실패',
      detail: lastError.message,
      resultCode: lastError.resultCode,
    });
  }

  // 2) 과거 lookback개월을 동시에(병렬) best-effort로 조회 - 순차 조회보다 훨씬 빠르다.
  //    개별 월 조회가 실패해도 나머지는 계속 사용한다(추정치일 뿐이므로).
  const pastYms = Array.from({ length: lookback }, (_, i) => shiftYm(dealYmd, i + 1));
  const pastResults = await Promise.allSettled(pastYms.map(ym => fetchMolitTradesRetried(lawdCd, ym, housingType, dealCategory)));

  const complexKey = (t) => `${t.umdNm}__${t.aptNm}`;
  const targetKeys = new Set(targetTrades.map(complexKey));
  const pastMonthsUsed = [];
  const estimateByComplex = new Map(); // key -> trade (더 최근 달 결과를 우선하도록 아래에서 순서 보장)

  pastResults.forEach((result, i) => {
    const ym = pastYms[i];
    if (result.status !== 'fulfilled') {
      console.error('[molit/trades-with-estimate] 과거월 조회 실패(무시하고 계속):', ym, result.reason?.message);
      return;
    }
    pastMonthsUsed.push(ym);
  });

  // 병렬로 받아온 결과를 "가장 최근 달 우선"으로 순서대로 다시 훑으며 병합한다.
  pastResults.forEach((result, i) => {
    if (result.status !== 'fulfilled') return;
    const ym = pastYms[i];
    for (const t of result.value) {
      const key = complexKey(t);
      if (targetKeys.has(key)) continue;       // 목표 월에 이미 실거래가 있으면 추정 불필요
      if (estimateByComplex.has(key)) continue; // 더 최근 달에서 이미 찾았으면 건너뜀
      estimateByComplex.set(key, { ...t, estimateBasisYm: ym });
    }
  });

  const estimateTrades = Array.from(estimateByComplex.values());

  // 3) 참고용 "인근 평균 평당가" - 이번 요청에서 모은 모든 실거래(목표월+과거월) 기준
  const allForAvg = [...targetTrades, ...estimateTrades];
  const pyeongPrices = allForAvg
    .filter(t => t.pyeong > 0)
    .map(t => t.dealAmountManwon / t.pyeong);
  const areaAvgManwonPerPyeong = pyeongPrices.length
    ? Math.round(pyeongPrices.reduce((a, b) => a + b, 0) / pyeongPrices.length)
    : null;

  res.json({
    lawdCd,
    dealYmd,
    trades: targetTrades.map(t => ({ ...t, isEstimate: false })),
    estimateTrades: estimateTrades.map(t => ({ ...t, isEstimate: true })),
    monthsUsed: [dealYmd, ...pastMonthsUsed],
    areaAvgManwonPerPyeong,
  });
});

// -----------------------------------------------------------------------
// 5) 지원되는 시군구 코드 목록 (프론트 드롭다운 채우는 용도)
// -----------------------------------------------------------------------
app.get('/api/lawd-codes', (req, res) => {
  res.json(LAWD_CODES);
});

app.listen(PORT, () => {
  console.log(`이사갈 곳 한방 검색 서버 실행 중: http://localhost:${PORT}`);
  if (!GOOGLE_MAPS_API_KEY) console.warn('⚠️  GOOGLE_MAPS_API_KEY가 .env에 설정되지 않았습니다. (지도 렌더링용)');
  if (!KAKAO_REST_API_KEY) console.warn('⚠️  KAKAO_REST_API_KEY가 .env에 설정되지 않았습니다. (좌표<->주소 변환용, 결제 등록 불필요)');
  if (!MOLIT_API_KEY) console.warn('⚠️  MOLIT_API_KEY가 .env에 설정되지 않았습니다.');
});
