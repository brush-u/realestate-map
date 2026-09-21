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
async function reverseGeocode(lat, lng) {
  const { data } = await axios.get('https://dapi.kakao.com/v2/local/geo/coord2regioncode.json', {
    params: { x: lng, y: lat }, // 카카오는 x=경도, y=위도 순서
    headers: kakaoHeaders,
  });
  // region_type "B"가 법정동(국토부 API 기준), "H"는 행정동이라 용도가 다르다.
  const region = data.documents?.find(d => d.region_type === 'B');
  if (!region) return null;
  const lawdCd = region.code ? region.code.slice(0, 5) : null;
  return {
    formattedAddress: region.address_name,
    sido: region.region_1depth_name || null,
    sigungu: region.region_2depth_name || null,
    lawdCd,
    supported: !!lawdCd,
  };
}

app.get('/api/geocode/reverse', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) {
    return res.status(400).json({ error: 'lat, lng 파라미터가 필요합니다.' });
  }
  if (!KAKAO_REST_API_KEY) {
    return res.status(500).json({ error: 'KAKAO_REST_API_KEY가 서버에 설정되지 않았습니다.' });
  }

  try {
    const result = await reverseGeocode(lat, lng);
    if (!result) {
      return res.status(404).json({ error: '해당 좌표의 법정동 정보를 찾지 못했습니다 (바다 등일 수 있습니다).' });
    }
    res.json(result);
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
// 3.5) 인근 시설 여부 확인 (역세권 / 백화점·아울렛·마트 / 공원 / 학교)
//    예전엔 매물 하나하나마다 카카오에 "이 근처에 있어?"를 따로 물어봤는데, 매물이
//    많아질수록 호출이 비례해서 늘어나 느려졌다. 이제는 검색 지역 전체에서 시설을
//    "한 번만" 찾아두고, 각 매물과의 거리는 서버 호출 없이 단순 계산으로 판정한다.
// -----------------------------------------------------------------------
const NEARBY_THRESHOLD_M = { subway: 500, mart: 1000, school: 500, park: 500 };

// 카카오 키워드 검색은 상호명에 "백화점/아울렛"이라는 글자만 들어가면 다 잡는다
// ("밧데리백화점", "주류백화점" 같은 잡화점도 포함). 실제 대형 유통 브랜드만 인정하도록
// 화이트리스트로 한 번 더 거른다. MT1(대형마트) 카테고리는 카카오 자체 분류라 신뢰하고
// 그대로 쓴다.
const KNOWN_RETAIL_BRANDS = [
  // 백화점
  '롯데백화점', '현대백화점', '신세계백화점', '갤러리아백화점', 'AK플라자', 'NC백화점', '더현대',
  // 아울렛
  '롯데아울렛', '현대아울렛', '신세계사이먼', '이랜드아울렛', '뉴코아아울렛', '세이브존', '마리오아울렛', '2001아울렛',
  // 대형 쇼핑몰
  '스타필드', '타임스퀘어', '코엑스', 'IFC몰', '파르나스몰', '롯데월드몰',
];
function isKnownRetailBrand(name) {
  return KNOWN_RETAIL_BRANDS.some(b => name.includes(b));
}

// 좌표 하나를 중심으로 반경 내 장소를 모두 찾는다 (페이지네이션 최대 3페이지 = 45건).
async function fetchFacilitiesInArea(lat, lng, radiusMeters, mode, queryOrCode) {
  const url = mode === 'category'
    ? 'https://dapi.kakao.com/v2/local/search/category.json'
    : 'https://dapi.kakao.com/v2/local/search/keyword.json';
  const docs = [];
  for (let page = 1; page <= 3; page++) {
    const params = mode === 'category'
      ? { category_group_code: queryOrCode, x: lng, y: lat, radius: radiusMeters, page, size: 15 }
      : { query: queryOrCode, x: lng, y: lat, radius: radiusMeters, page, size: 15 };
    try {
      const { data } = await axios.get(url, { params, headers: kakaoHeaders });
      docs.push(...(data.documents || []));
      if (data.meta?.is_end !== false) break; // 다음 페이지 없으면 중단
    } catch (err) {
      console.error('[fetchFacilitiesInArea]', mode, queryOrCode, err.response?.data || err.message);
      break;
    }
  }
  return docs.map(d => ({ name: d.place_name, lat: Number(d.y), lng: Number(d.x) }));
}

// 검색 반경(searchRadius) + 판정 임계값을 더한 범위에서 시설을 한 번만 조회한다.
// (카카오 검색 반경 상한이 20km라 그 이상은 잘라낸다 - 매우 넓은 반경의 드문 경우)
app.get('/api/nearby-facilities', async (req, res) => {
  const { type } = req.query;
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radiusKm = parseFloat(req.query.radiusKm) || 5;

  const threshold = NEARBY_THRESHOLD_M[type];
  if (!threshold) {
    return res.status(400).json({ error: `지원하지 않는 type입니다: ${type}` });
  }
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat, lng 파라미터가 필요합니다.' });
  }
  if (!KAKAO_REST_API_KEY) {
    return res.status(500).json({ error: 'KAKAO_REST_API_KEY가 서버에 설정되지 않았습니다.' });
  }

  const radiusMeters = Math.min(radiusKm * 1000 + threshold, 20000);

  let facilities = [];
  try {
    if (type === 'subway') {
      facilities = await fetchFacilitiesInArea(lat, lng, radiusMeters, 'category', 'SW8');
    } else if (type === 'school') {
      facilities = await fetchFacilitiesInArea(lat, lng, radiusMeters, 'category', 'SC4');
    } else if (type === 'park') {
      facilities = await fetchFacilitiesInArea(lat, lng, radiusMeters, 'keyword', '공원');
    } else if (type === 'mart') {
      const [martCat, dept, outlet] = await Promise.all([
        fetchFacilitiesInArea(lat, lng, radiusMeters, 'category', 'MT1'),
        fetchFacilitiesInArea(lat, lng, radiusMeters, 'keyword', '백화점'),
        fetchFacilitiesInArea(lat, lng, radiusMeters, 'keyword', '아울렛'),
      ]);
      facilities = [
        ...martCat, // MT1은 카카오 자체 분류라 신뢰 (화이트리스트 불필요)
        ...dept.filter(f => isKnownRetailBrand(f.name)),
        ...outlet.filter(f => isKnownRetailBrand(f.name)),
      ];
    }
  } catch (e) {
    return res.status(502).json({ error: '카카오 장소검색 실패', detail: e.message });
  }

  // 좌표 기준 중복 제거 (같은 지점이 여러 검색어에 겹쳐 나올 수 있음)
  const seen = new Set();
  facilities = facilities.filter(f => {
    const key = `${f.lat.toFixed(5)},${f.lng.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  res.json({ type, thresholdMeters: threshold, facilities });
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
      timeout: 25000, // 국토부 API가 느릴 때가 있어 넉넉하게 잡음 (Cloud Run 자체 타임아웃이 더 짧으면 그게 먼저 끊는다)
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
// (국토부 API가 느릴 때가 있어 개별 호출에는 시간을 넉넉히 주되, 무한정 재시도하지는 않는다 -
//  실제 병목이 Cloud Run 자체의 요청 제한시간(Request timeout)일 수 있으니, 그 값도 확인 필요)
async function fetchMolitTradesRetried(lawdCd, dealYmd, housingType = 'apt', dealCategory = 'trade') {
  const MAX_ATTEMPTS = 2;
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

// -----------------------------------------------------------------------
// 4.7) 지역 비교분석 - 여러 지점의 실거래가를 최근 N개월치 모아 통계로 요약한다.
//    지도에 개별 마커를 찍는 게 아니라 "평당가/추이/층별/평형별" 집계만 필요하므로
//    좌표 지오코딩이 필요 없어 훨씬 가볍고 빠르다.
// -----------------------------------------------------------------------
app.post('/api/molit/area-analysis', async (req, res) => {
  const { areas, dealYmd } = req.body || {};
  const months = Math.min(parseInt(req.body?.months, 10) || 6, 12);
  const housingType = req.body?.housingType || 'apt';
  const dealCategory = req.body?.dealCategory || 'trade';

  if (!Array.isArray(areas) || areas.length === 0) {
    return res.status(400).json({ error: 'areas 배열이 필요합니다.' });
  }
  if (!dealYmd || !/^\d{6}$/.test(dealYmd)) {
    return res.status(400).json({ error: 'dealYmd(YYYYMM)가 필요합니다.' });
  }
  if (!MOLIT_API_KEY) {
    return res.status(500).json({ error: 'MOLIT_API_KEY가 서버에 설정되지 않았습니다.' });
  }

  const validAreas = areas.filter(a => a && a.lawdCd && /^\d{5}$/.test(a.lawdCd)).slice(0, 6);
  if (validAreas.length === 0) {
    return res.status(400).json({ error: '유효한 시군구코드가 없습니다.' });
  }

  const monthsList = [dealYmd, ...Array.from({ length: months - 1 }, (_, i) => shiftYm(dealYmd, i + 1))];
  const monthlyTrend = [];
  let targetTrades = [];

  for (const ym of monthsList) {
    let combined = [];
    // 지역을 2개씩 나눠 조회해 순간 동시 호출량을 낮춘다 (초당 호출 제한 대비).
    for (let i = 0; i < validAreas.length; i += 2) {
      const batch = validAreas.slice(i, i + 2);
      const results = await Promise.allSettled(batch.map(a => fetchMolitTradesRetried(a.lawdCd, ym, housingType, dealCategory)));
      results.forEach(r => { if (r.status === 'fulfilled') combined.push(...r.value); });
      if (i + 2 < validAreas.length) await sleep(150);
    }
    if (ym === dealYmd) targetTrades = combined;

    const pricePerPyeongs = combined.filter(t => t.pyeong > 0).map(t => t.dealAmountManwon / t.pyeong);
    const avgManwonPerPyeong = pricePerPyeongs.length
      ? Math.round(pricePerPyeongs.reduce((a, b) => a + b, 0) / pricePerPyeongs.length)
      : null;
    monthlyTrend.push({ ym, avgManwonPerPyeong, count: combined.length });
    await sleep(150);
  }

  // 층별 구간 요약 (목표월 기준)
  const floorBuckets = [
    { band: '저층(1~5층)', test: (f) => f <= 5 },
    { band: '중층(6~15층)', test: (f) => f > 5 && f <= 15 },
    { band: '고층(16층~)', test: (f) => f > 15 },
  ];
  const floorSummary = floorBuckets.map(({ band, test }) => {
    const vals = targetTrades.filter(t => test(parseInt(t.floor, 10) || 0) && t.pyeong > 0).map(t => t.dealAmountManwon / t.pyeong);
    return { band, avgManwonPerPyeong: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null, count: vals.length };
  });

  // 평형별 구간 요약 (목표월 기준)
  const pyeongBuckets = [
    { band: '소형(~20평)', test: (p) => p <= 20 },
    { band: '중형(20~35평)', test: (p) => p > 20 && p <= 35 },
    { band: '대형(35평~)', test: (p) => p > 35 },
  ];
  const pyeongSummary = pyeongBuckets.map(({ band, test }) => {
    const vals = targetTrades.filter(t => test(t.pyeong) && t.pyeong > 0).map(t => t.dealAmountManwon / t.pyeong);
    return { band, avgManwonPerPyeong: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null, count: vals.length };
  });

  const latestDealDate = targetTrades.length
    ? targetTrades.map(t => `${t.dealYear}-${String(t.dealMonth).padStart(2, '0')}-${String(t.dealDay).padStart(2, '0')}`).sort().pop()
    : null;

  res.json({
    dealYmd,
    monthlyTrend: monthlyTrend.reverse(), // 오래된 달 -> 최신 달 순서로
    totalCount: targetTrades.length,
    latestDealDate,
    floorSummary,
    pyeongSummary,
  });
});

// -----------------------------------------------------------------------
// 4.8) AR 오버레이용 - 현재 좌표 주변의 실거래 단지를 좌표와 함께 반환한다.
//    (역지오코딩 -> 이번달 실거래 조회 -> 단지별 집계 -> 좌표 변환 -> 거리 필터
//    를 한 번의 호출로 처리해서 클라이언트를 단순하게 유지한다)
// -----------------------------------------------------------------------
app.get('/api/molit/nearby-complexes', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const housingType = req.query.housingType || 'apt';
  const dealCategory = req.query.dealCategory || 'trade';
  const radiusKm = Math.min(parseFloat(req.query.radiusKm) || 1.5, 5);

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat, lng 파라미터가 필요합니다.' });
  }
  if (!MOLIT_API_KEY || !KAKAO_REST_API_KEY) {
    return res.status(500).json({ error: '서버에 필요한 API 키가 설정되지 않았습니다.' });
  }

  // 1) 역지오코딩으로 현재 위치의 시군구코드 확인
  let region;
  try {
    region = await reverseGeocode(lat, lng);
  } catch (err) {
    return res.status(502).json({ error: '위치 확인(지오코딩) 실패', detail: err.message });
  }
  if (!region || !region.supported) {
    return res.status(404).json({ error: '이 위치의 시군구코드를 확인하지 못했습니다.' });
  }

  // 1.5) 반경이 1km를 넘으면, 주변 4방향도 샘플링해서 인접 시군구까지 포함한다.
  //    (반경 안에 여러 시군구가 걸쳐있는 경우가 흔해서, 내 위치의 시군구 하나만 보면
  //    실제로는 가까운데도 다른 시군구라 누락되는 단지가 많았다)
  const regionsMap = new Map();
  regionsMap.set(region.lawdCd, region);
  if (radiusKm > 1) {
    const toRad = (d) => d * Math.PI / 180;
    const destPoint = (baseLat, baseLng, distKm, bearingDeg) => {
      const R = 6371;
      const brng = toRad(bearingDeg);
      const lat1 = toRad(baseLat), lng1 = toRad(baseLng);
      const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distKm / R) + Math.cos(lat1) * Math.sin(distKm / R) * Math.cos(brng));
      const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(distKm / R) * Math.cos(lat1), Math.cos(distKm / R) - Math.sin(lat1) * Math.sin(lat2));
      return { lat: lat2 * 180 / Math.PI, lng: lng2 * 180 / Math.PI };
    };
    const bearings = [0, 90, 180, 270]; // 북, 동, 남, 서
    const points = bearings.map(b => destPoint(lat, lng, radiusKm, b));
    const settled = await Promise.allSettled(points.map(p => reverseGeocode(p.lat, p.lng)));
    settled.forEach(r => {
      if (r.status === 'fulfilled' && r.value && r.value.supported && !regionsMap.has(r.value.lawdCd)) {
        regionsMap.set(r.value.lawdCd, r.value);
      }
    });
  }
  const regions = [...regionsMap.values()].slice(0, 5);

  // 2) 각 지역마다 최근 3개월치를 모두 모은다 (첫 달에 데이터가 있어도 멈추지 않고
  //    계속 모아서 단지 개수를 늘린다 - 실거래는 며칠 걸러 나오는 경우가 많다)
  const now = new Date();
  const monthsToTry = [0, 1, 2].map(back => shiftYm(`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`, back));
  let trades = [];
  let usedYmd = null;
  for (let i = 0; i < regions.length; i += 2) {
    const regionBatch = regions.slice(i, i + 2);
    for (const ym of monthsToTry) {
      const results = await Promise.allSettled(
        regionBatch.map(r => fetchMolitTradesRetried(r.lawdCd, ym, housingType, dealCategory)
          .then(list => list.map(t => ({ ...t, _sido: r.sido, _sigungu: r.sigungu }))))
      );
      results.forEach(res => {
        if (res.status === 'fulfilled' && res.value.length > 0) {
          trades.push(...res.value);
          if (!usedYmd || ym > usedYmd) usedYmd = ym;
        }
      });
      await sleep(120);
    }
  }
  if (trades.length === 0) {
    return res.json({ region, usedYmd: null, complexes: [] });
  }

  // 3) 단지(주소)별로 묶어서 최근 거래가/거래건수 집계
  const byAddress = new Map();
  trades.forEach(t => {
    const address = `${t._sido} ${t._sigungu} ${t.umdNm} ${t.aptNm}`.trim();
    if (!byAddress.has(address)) {
      byAddress.set(address, { name: t.aptNm, dong: t.umdNm, deals: [] });
    }
    byAddress.get(address).deals.push(t);
  });

  // 4) 단지 주소들을 좌표로 변환 (기존 배치 지오코딩 재사용, 캐시 적용됨)
  const addresses = [...byAddress.keys()];
  const CONCURRENCY = 6;
  const geocodeMap = {};
  for (let i = 0; i < addresses.length; i += CONCURRENCY) {
    const batch = addresses.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(geocodeOne));
    batch.forEach((addr, idx) => { geocodeMap[addr] = results[idx]; });
    if (i + CONCURRENCY < addresses.length) await sleep(100);
  }

  // 5) 좌표가 확보된 단지만, 현재 위치로부터의 거리를 계산해 반경 내로 필터링
  const toRad = (deg) => deg * Math.PI / 180;
  const haversineKm = (lat1, lng1, lat2, lng2) => {
    const R = 6371;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const complexes = [];
  for (const [address, info] of byAddress.entries()) {
    const loc = geocodeMap[address];
    if (!loc) continue;
    const distanceKm = haversineKm(lat, lng, loc.lat, loc.lng);
    if (distanceKm > radiusKm) continue;

    const prices = info.deals.map(d => d.dealAmountEok).filter(p => p > 0);
    const latest = info.deals.slice().sort((a, b) => `${b.dealYear}${String(b.dealMonth).padStart(2,'0')}${String(b.dealDay).padStart(2,'0')}`.localeCompare(`${a.dealYear}${String(a.dealMonth).padStart(2,'0')}${String(a.dealDay).padStart(2,'0')}`))[0];

    complexes.push({
      name: info.name,
      dong: info.dong,
      lat: loc.lat,
      lng: loc.lng,
      distanceKm: Math.round(distanceKm * 100) / 100,
      dealCount: info.deals.length,
      avgPriceEok: prices.length ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100 : null,
      latestPriceEok: latest ? latest.dealAmountEok : null,
      latestPyeong: latest ? latest.pyeong : null,
      latestFloor: latest ? latest.floor : null,
      latestDate: latest ? `${latest.dealYear}-${String(latest.dealMonth).padStart(2, '0')}-${String(latest.dealDay).padStart(2, '0')}` : null,
      isJeonse: latest ? !!latest.isJeonse : undefined,
      monthlyRentManwon: latest ? (latest.monthlyRentManwon || 0) : 0,
    });
  }

  complexes.sort((a, b) => a.distanceKm - b.distanceKm);

  res.json({ region, usedYmd, complexes });
});

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

  // 2) 과거 lookback개월을 3개씩 나눠서 조회한다 (완전 병렬은 다른 지역의 동시 요청과
  //    겹치면 "초당 호출 제한"에 걸리기 쉬워서, 순간 동시 호출량을 적당히 낮춘다).
  //    개별 월 조회가 실패해도 나머지는 계속 사용한다(추정치일 뿐이므로).
  const pastYms = Array.from({ length: lookback }, (_, i) => shiftYm(dealYmd, i + 1));
  const pastResults = [];
  const MONTH_BATCH_SIZE = 3;
  for (let i = 0; i < pastYms.length; i += MONTH_BATCH_SIZE) {
    const batch = pastYms.slice(i, i + MONTH_BATCH_SIZE);
    const batchResults = await Promise.allSettled(batch.map(ym => fetchMolitTradesRetried(lawdCd, ym, housingType, dealCategory)));
    pastResults.push(...batchResults);
    if (i + MONTH_BATCH_SIZE < pastYms.length) await sleep(200);
  }

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
  console.log(`내 집 한방 뽑기 서버 실행 중: http://localhost:${PORT}`);
  if (!GOOGLE_MAPS_API_KEY) console.warn('⚠️  GOOGLE_MAPS_API_KEY가 .env에 설정되지 않았습니다. (지도 렌더링용)');
  if (!KAKAO_REST_API_KEY) console.warn('⚠️  KAKAO_REST_API_KEY가 .env에 설정되지 않았습니다. (좌표<->주소 변환용, 결제 등록 불필요)');
  if (!MOLIT_API_KEY) console.warn('⚠️  MOLIT_API_KEY가 .env에 설정되지 않았습니다.');
});
