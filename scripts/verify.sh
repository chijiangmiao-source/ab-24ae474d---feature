#!/bin/sh
# 自动验收：代码测试 → 构建 → 健康 HTTP 冒烟；任一环节失败即非零退出。
set -e
cd "$(dirname "$0")/.."

WEB_URL="${WEB_URL:-http://web}"

echo "==> [1/3] 代码测试（vitest：并发收敛 / 乱序暂存释放 / 重复幂等 / 校验拒绝）"
npm run test:run

echo "==> [2/3] 构建（tsc 类型检查 + vite 产物）"
npm run build

echo "==> [3/3] 健康 HTTP 冒烟（${WEB_URL}）"
i=0
until wget -q -O /tmp/health.out "${WEB_URL}/health"; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "FAIL: 健康路径 ${WEB_URL}/health 等待超时"
    exit 1
  fi
  sleep 1
done
if ! grep -q '^ok' /tmp/health.out; then
  echo "FAIL: /health 响应异常：$(cat /tmp/health.out)"
  exit 1
fi
echo "    /health -> $(cat /tmp/health.out)"

wget -q -O /tmp/index.out "${WEB_URL}/"
if ! grep -q 'id="root"' /tmp/index.out; then
  echo "FAIL: 首页缺少 root 挂载节点"
  exit 1
fi
echo "    / -> 200, 包含 root 挂载节点"

echo "VERIFY OK: 测试、构建、健康冒烟全部通过"
exit 0
