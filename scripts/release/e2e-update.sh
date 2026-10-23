#!/usr/bin/env bash
# 隔离 Docker 演练：真实发布包、更新器下载/解压/切换与 60s web 代理健康回退。
# 所有容器/网络/卷均以 hub-e2e- 开头；随机宿主端口，不使用根 .env。
set -euo pipefail
cd "$(dirname "$0")/../.."
V1=v0.1.2-e2e.1
V2=v0.1.2-e2e.2
RUN="hub-e2e-$$"
NET="$RUN-net"; PG="$RUN-pg"; APP="$RUN-app"; GH="$RUN-gh"
IMAGE="$RUN-image:$V1"
PG_VOL="$RUN-pg-data"; A_VOL="$RUN-data-a"; B_VOL="$RUN-data-b"
TMP=$(mktemp -d /tmp/hub-e2e-XXXXXX)
PASS=0
say() { echo "[e2e] $*"; }
assert_eq() {
  if [ "$1" != "$2" ]; then say "✗ $3：期望 $2，实际 $1"; exit 1; fi
  PASS=$((PASS + 1)); say "✓ $3（$1）"
}
http_code() { curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$1" || true; }
json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const p of process.argv[1].split("."))v=v?.[p];process.stdout.write(String(v??""))}catch{}})' "$1"; }
task_field() { docker exec "$APP" cat /app/data/update-task.json 2>/dev/null | json_field "$1" || true; }
health_version() { curl -s --max-time 3 "$BASE/api/v1/healthz" 2>/dev/null | json_field version || true; }
api_version() { docker exec "$APP" node -e 'fetch("http://127.0.0.1:8711/healthz").then(r=>r.json()).then(j=>process.stdout.write(j.ok?j.version:""))' 2>/dev/null || true; }
wait_for() {
  local label="$1" want="$2" command="$3" deadline=$((SECONDS + ${4:-180})) got=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    got=$(eval "$command")
    if [ "$got" = "$want" ]; then assert_eq "$got" "$want" "$label"; return; fi
    sleep 2
  done
  assert_eq "$got" "$want" "$label（超时）"
}
cleanup() {
  local code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then
    docker logs --tail 45 "$APP" 2>&1 || true
    docker exec "$APP" cat /app/data/update-task.json 2>/dev/null || true
  fi
  say "清理 $RUN 的容器、网络、卷、镜像与临时发布包"
  docker rm -f -v "$APP" "$GH" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$A_VOL" "$B_VOL" "$PG_VOL" >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$TMP" "dist/release/$V1" "dist/release/$V2" "dist/release/$V2-broken"
  rm -f "dist/2api-hub-$V1.tar.gz" "dist/2api-hub-$V2.tar.gz" "dist/2api-hub-$V2-broken.tar.gz"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "构建演练发布包 $V1"
pnpm release:build --tag "$V1" > "$TMP/build.log" 2>&1 || { cat "$TMP/build.log"; exit 1; }
# 保留相对符号链接；A/B 各自从 e2e.1 出发，B 不会把旧健康响应误判为回退成功。
node --input-type=module - "$V1" "$V2" <<'JS'
import { cpSync, rmSync, readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const [v1,v2] = process.argv.slice(2);
for (const broken of [false,true]) {
  const root = `dist/release/${v2}${broken?'-broken':''}`;
  rmSync(root,{recursive:true,force:true});
  cpSync(`dist/release/${v1}`,root,{recursive:true,verbatimSymlinks:true});
  const meta = JSON.parse(readFileSync(join(root,'release.json')));
  writeFileSync(join(root,'release.json'),JSON.stringify({...meta,version:v2}));
  if (broken) rmSync(join(root,'web/apps/web/.next/server/app/api/v1/[...path]/route.js')); // 不可静默忽略路径变化
  const hashes=[],links=[];
  const walk=(dir,rel='')=>{for(const name of readdirSync(dir)){
    const path=join(dir,name), r=rel?`${rel}/${name}`:name, st=lstatSync(path);
    if(st.isSymbolicLink())links.push(`${r} -> ${readlinkSync(path)}`);
    else if(st.isDirectory())walk(path,r);
    else if(st.isFile()&&!['files.sha256','files.symlinks'].includes(r))hashes.push(`${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${r}`);
  }};
  walk(root);
  writeFileSync(join(root,'files.symlinks'),links.sort().join('\n')+(links.length?'\n':''));
  hashes.push(`${createHash('sha256').update(readFileSync(join(root,'files.symlinks'))).digest('hex')}  files.symlinks`);
  writeFileSync(join(root,'files.sha256'),hashes.sort().join('\n')+'\n');
}
JS
for suffix in '' '-broken'; do
  COPYFILE_DISABLE=1 tar -czf "dist/2api-hub-$V2$suffix.tar.gz" -C "dist/release/$V2$suffix" .
done
say "用根 Dockerfile 构建演练镜像（也是生产镜像构建烟雾检查）"
docker build --build-arg NODE_IMAGE_REGISTRY="${NODE_IMAGE_REGISTRY:-docker.io/library}" \
  --build-arg RELEASE_TAG="$V1" -t "$IMAGE" . > "$TMP/docker-build.log" 2>&1 || { cat "$TMP/docker-build.log"; exit 1; }

docker network create "$NET" >/dev/null
for volume in "$PG_VOL" "$A_VOL" "$B_VOL"; do docker volume create "$volume" >/dev/null; done
docker run -d --name "$PG" --network "$NET" -v "$PG_VOL:/var/lib/postgresql/data" \
  -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=hub \
  "${NODE_IMAGE_REGISTRY:-docker.io/library}/postgres:16-alpine" >/dev/null
pg_ready=false
for i in $(seq 1 40); do
  if docker exec "$PG" pg_isready -U hub >/dev/null 2>&1; then pg_ready=true; break; fi
  sleep 1
done
assert_eq "$pg_ready" true "隔离 postgres 就绪"

mkdir "$TMP/assets"
cat > "$TMP/fake-gh.cjs" <<'JS'
const http=require('node:http'),fs=require('node:fs');
http.createServer((req,res)=>{
  const path=req.url==='/repos/FluxCode666/2api-hub/releases/latest'?'/assets/latest.json':`/assets/${req.url.split('/').pop()}`;
  if(!fs.existsSync(path)){res.writeHead(404).end();return;}
  res.setHeader('content-length',fs.statSync(path).size);
  if(path.endsWith('.json'))res.setHeader('content-type','application/json');
  fs.createReadStream(path).pipe(res);
}).listen(9000,'0.0.0.0');
JS
docker run -d --name "$GH" --network "$NET" -v "$TMP/assets:/assets:ro" -v "$TMP/fake-gh.cjs:/fake-gh.cjs:ro" \
  "${NODE_IMAGE_REGISTRY:-docker.io/library}/node:22-alpine" node /fake-gh.cjs >/dev/null
setup_fake_gh() {
  cp "dist/2api-hub-$V2$1.tar.gz" "$TMP/assets/2api-hub-$V2.tar.gz"
  (cd "$TMP/assets" && shasum -a 256 "2api-hub-$V2.tar.gz" > checksums.txt)
  node --input-type=module - "$TMP/assets" "$V2" "$GH" <<'JS'
import {writeFileSync,statSync} from 'node:fs';
const [dir,tag,host]=process.argv.slice(2);
const assets=[`2api-hub-${tag}.tar.gz`,'checksums.txt'];
// 本地 fake latest 直接返回演练 tag；不发布到 GitHub，也不改变生产版本筛选策略。
writeFileSync(`${dir}/latest.json`,JSON.stringify({tag_name:tag,name:tag,prerelease:false,published_at:new Date().toISOString(),body:'e2e',html_url:'http://fake/release',assets:assets.map(name=>({name,size:statSync(`${dir}/${name}`).size,browser_download_url:`http://${host}:9000/assets/${name}`}))}));
JS
}
start_app() {
  docker rm -f -v "$APP" >/dev/null 2>&1 || true
  docker run -d --name "$APP" --network "$NET" -p 127.0.0.1::3210 -v "$1:/app/data" \
    -e DATABASE_URL="postgres://hub:e2e@$PG:5432/hub" \
    -e APP_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    -e SESSION_SECRET=e2e-session-secret -e INIT_ADMIN_EMAIL=admin@e2e.local -e INIT_ADMIN_PASSWORD=e2e-admin-pass-123 \
    -e HUB_GITHUB_API_BASE="http://$GH:9000" -e HUB_UPDATE_ALLOWED_HOSTS="$GH" -e COOKIE_SECURE=false "$IMAGE" >/dev/null
  BASE="http://$(docker port "$APP" 3210/tcp)"
  wait_for "起始版本 healthz" "$V1" health_version
  curl -fsS --max-time 20 -c "$TMP/cookie" -X POST "$BASE/api/v1/auth/login" \
    -H 'content-type: application/json' -d '{"email":"admin@e2e.local","password":"e2e-admin-pass-123"}' > /dev/null
  assert_eq "$(curl -fsS -b "$TMP/cookie" "$BASE/api/v1/auth/me" | json_field role)" admin "管理员登录"
}
trigger_update() {
  local response="$TMP/response.json" code
  code=$(curl -sS --max-time 20 -b "$TMP/cookie" -o "$response" -w '%{http_code}' -X POST "$BASE/api/v1/admin/system/update" \
    -H 'content-type: application/json' -d "{\"targetVersion\":\"$V2\"}")
  assert_eq "$code" 202 "更新请求已接受"
  TASK_ID=$(json_field id < "$response")
  [ -n "$TASK_ID" ]
}

say "场景 A：$V1 → $V2 成功更新"
setup_fake_gh ''
start_app "$A_VOL"
assert_eq "$(curl -fsS -b "$TMP/cookie" "$BASE/api/v1/admin/system/version?refresh=true" | json_field canUpdate)" true "canUpdate"
# 模拟上一次失败留下的同 tag 残缺目录，验证更新器不会复用它。
docker exec "$APP" sh -c "mkdir -p /app/data/releases/$V2/api; echo stale > /app/data/releases/$V2/api/index.mjs"
trigger_update
wait_for "前端代理 healthz 新版本" "$V2" health_version
wait_for "update-task.json succeeded" succeeded 'task_field status'
assert_eq "$(task_field id)" "$TASK_ID" "任务 ID 保留"
assert_eq "$(api_version)" "$V2" "API 直连版本"
assert_eq "$(http_code "$BASE/")" 200 "更新后首页"
assert_eq "$(http_code "$BASE/api/v1/meta")" 200 "更新后 /api/v1/meta"
assert_eq "$(docker exec "$APP" node -p 'require("fs").readlinkSync("/app/data/current")')" "releases/$V2" "current 已切换"

say "场景 B：独立卷从 ${V1} 更新到 web 代理损坏的 ${V2}，再自动回退到 ${V1}"
setup_fake_gh '-broken'
start_app "$B_VOL"
trigger_update
wait_for "坏版本 API 正常且版本已切换" "$V2" api_version
BAD_AT=$SECONDS
assert_eq "$(http_code "$BASE/api/v1/healthz")" 500 "坏版本 web 代理 healthz"
assert_eq "$(http_code "$BASE/api/v1/meta")" 500 "坏版本 web 代理 meta"
wait_for "update-task.json rolled_back" rolled_back 'task_field status'
ELAPSED=$((SECONDS - BAD_AT))
if [ "$ELAPSED" -lt 55 ]; then say "✗ 未走满 60s 健康窗口（${ELAPSED}s）"; exit 1; fi
say "✓ 观察到坏版本后 ${ELAPSED}s 自动回退（60s 窗口 + 10s 巡检）"
assert_eq "$(task_field id)" "$TASK_ID" "回退保留原任务 ID"
wait_for "回退后代理 healthz" "$V1" health_version
assert_eq "$(api_version)" "$V1" "回退后 API 直连版本"
assert_eq "$(http_code "$BASE/")" 200 "回退后首页"
assert_eq "$(http_code "$BASE/api/v1/meta")" 200 "回退后 /api/v1/meta"
assert_eq "$(curl -fsS -b "$TMP/cookie" "$BASE/api/v1/admin/system/version" | json_field task.status)" rolled_back "管理员可见回退任务"
assert_eq "$(docker exec "$APP" node -p 'require("/app/data/supervisor.json").version')" "$V1" "supervisor 运行版本"
docker logs "$APP" 2>&1 | rg '60s 内未通过健康检查|回退到' || { say '✗ 缺少健康超时回退日志'; exit 1; }
say "演练完成：$PASS 项断言通过"
