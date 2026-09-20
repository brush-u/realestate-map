#!/bin/bash
# 배포 스크립트 - GitHub에 push하면 Cloud Run 자동배포(마법사로 연결된 트리거)가 실행됩니다.
#
# 사용법:
#   ./deploy.sh "커밋 메시지"
#   (메시지를 안 넣으면 날짜/시간으로 자동 생성됩니다)

set -e  # 중간에 하나라도 실패하면 즉시 멈춤 (예: 커밋할 변경사항이 없는 경우 등)

COMMIT_MSG="${1:-업데이트 $(date '+%Y-%m-%d %H:%M')}"

echo "▶ 변경사항 확인 중..."
git add .

if git diff --cached --quiet; then
    echo "⚠ 커밋할 변경사항이 없습니다. 종료합니다."
    exit 0
fi

echo "▶ 커밋: \"$COMMIT_MSG\""
git commit -m "$COMMIT_MSG"

echo "▶ GitHub로 push 중..."
git push

echo "✅ push 완료! Cloud Run 콘솔의 'REVISIONS' 탭에서 몇 분 내로 자동 배포되는 걸 확인하세요."
echo "   (Cloud Build 진행상황: GCP 콘솔 > Cloud Build > 기록)"
