# 배포 스크립트 (PowerShell) - GitHub에 push하면 Cloud Run 자동배포(마법사로 연결된 트리거)가 실행됩니다.
#
# 사용법:
#   .\deploy.ps1 "커밋 메시지"
#   (메시지를 안 넣으면 날짜/시간으로 자동 생성됩니다)
#
# 처음 한 번, PowerShell에서 스크립트 실행이 막혀있다면 아래를 먼저 실행하세요:
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

param(
    [string]$CommitMessage = "업데이트 $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
)

$ErrorActionPreference = "Stop"

Write-Host "▶ 변경사항 확인 중..."
git add .

$staged = git diff --cached --name-only
if (-not $staged) {
    Write-Host "⚠ 커밋할 변경사항이 없습니다. 종료합니다."
    exit 0
}

Write-Host "▶ 커밋: `"$CommitMessage`""
git commit -m "$CommitMessage"

Write-Host "▶ GitHub로 push 중..."
git push

Write-Host "✅ push 완료! Cloud Run 콘솔의 'REVISIONS' 탭에서 몇 분 내로 자동 배포되는 걸 확인하세요."
Write-Host "   (Cloud Build 진행상황: GCP 콘솔 > Cloud Build > 기록)"
