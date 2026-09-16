# =========================================================================
# 실거래 한방검색 (realestate-map) - GitHub push + Vercel 배포 스크립트
# 실행 위치: D:\workspace\realestate-map (PowerShell)
# =========================================================================

# -------------------------------------------------------------------------
# [1] 최초 1회만 실행 (이미 완료했다면 건너뛰어도 됩니다)
# -------------------------------------------------------------------------
#
# git init
# git add .
# git commit -m "실거래 한방검색 - Vercel 배포용 서버리스 구조 추가 (api/index.js, vercel.json)"
# git branch -M main
# git remote add origin https://<본인의 GitHub Personal Access Token>@github.com/brush-u/realestate-map.git
# git push -u origin main
#
# 이후 Vercel 대시보드에서:
#   - GitHub 저장소 Import
#   - Settings > Build and Deployment > Framework Preset = "Other"로 지정 후 Save
#   - Settings > Environment Variables 에 GOOGLE_MAPS_API_KEY / KAKAO_REST_API_KEY / MOLIT_API_KEY 등록
#   - Google Cloud Console에서 Maps API 키의 허용 도메인에 배포 주소(예: https://realestate-map-coral.vercel.app/*) 추가

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

Write-Host "`n[4/4] GitHub로 push (Vercel이 자동으로 재배포를 시작합니다)" -ForegroundColor Cyan
git push

Write-Host "`n완료! Vercel 대시보드(Deployments 탭)에서 새 배포 진행 상황을 확인하세요." -ForegroundColor Green
Write-Host "https://vercel.com/brushu1/realestate-map/deployments" -ForegroundColor Green
