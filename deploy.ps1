# =========================================================================
# 실거래 한방검색 (realestate-map) - GitHub push + Cloud Run 자동 배포 스크립트
# 실행 위치: D:\workspace\realestate-map (PowerShell)
# =========================================================================

# -------------------------------------------------------------------------
# [1] 최초 1회만 실행 (이미 완료했다면 건너뛰어도 됩니다)
# -------------------------------------------------------------------------
#
# git init
# git add .
# git commit -m "실거래 한방검색 - Cloud Run 배포용 Dockerfile 추가"
# git branch -M main
# git remote add origin https://<본인의 GitHub Personal Access Token>@github.com/brush-u/realestate-map.git
# git push -u origin main
#
# 이후 Google Cloud Run 콘솔(console.cloud.google.com/run)에서:
#   - 서비스 만들기 > "저장소에서 지속적으로 배포" 선택
#   - Cloud Build로 GitHub 계정 연결 후 brush-u/realestate-map 저장소, main 브랜치 선택
#   - 빌드 유형: Dockerfile (저장소에 포함된 Dockerfile 사용)
#   - 리전: asia-northeast3 (서울)
#   - 인증되지 않은 호출 허용 체크
#   - 환경 변수에 GOOGLE_MAPS_API_KEY / KAKAO_REST_API_KEY / MOLIT_API_KEY 등록
#   - Google Cloud Console에서 Maps API 키의 허용 도메인에 배포 주소(예: https://realestate-map-xxxxxxxxxx-du.a.run.app/*) 추가

# -------------------------------------------------------------------------
# [2] 코드를 수정할 때마다 반복 실행 (이 스크립트의 실제 목적)
# -------------------------------------------------------------------------

param(
    # 커밋 메시지를 지정하지 않으면 날짜/시간이 자동으로 들어갑니다.
    [string]$Message = "업데이트 $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
)

Write-Host "`n[1/4] 변경사항 확인 중..." -ForegroundColor Cyan
git status --short

Write-Host "`n[2/4] 변경사항 스테이징 (git add .)" -ForegroundColor Cyan
git add .

Write-Host "`n[3/4] 커밋 생성: $Message" -ForegroundColor Cyan
git commit -m "$Message"

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n커밋할 변경사항이 없거나 커밋에 실패했습니다. 위 메시지를 확인하세요." -ForegroundColor Yellow
    exit
}

Write-Host "`n[4/4] GitHub로 push (Cloud Build 트리거가 감지해서 자동으로 다시 빌드/배포합니다)" -ForegroundColor Cyan
git push

Write-Host "`n완료! Cloud Run 콘솔에서 새 빌드/배포 진행 상황을 확인하세요." -ForegroundColor Green
Write-Host "https://console.cloud.google.com/run" -ForegroundColor Green
Write-Host "(빌드 로그는 Cloud Build 기록에서도 확인 가능: https://console.cloud.google.com/cloud-build/builds)" -ForegroundColor Green
