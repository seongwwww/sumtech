# Windows Buzz 협업 Bridge

개발자마다 기존 Codex CLI / Claude Code와 로컬 Bridge를 유지하는 Windows 협업 환경입니다. HTTPS NIP-98 서명 `POST /query`, `POST /events`를 사용합니다. Relay는 `https://buzz-ciik.srv2103980.hstgr.cloud`이며 개인 설정은 `config/local.json`에서 읽습니다.

각 PC는 Agent-A부터 Agent-J까지 서로 다른 이름과 로컬 identity를 사용하고, 해당 Agent를 호출할 팀원의 HEX 공개키를 설정합니다. 작업 보고·문서·Issue/PR를 공유하며 기존 터미널 대화는 공유하지 않습니다. 현재 실환경 검증은 Agent-A PC 한 대에서 수행했고, 나머지 PC는 아래 설치 절차를 실제 수행한 뒤 체크리스트에 기록해야 합니다.

## 설치와 계정

Windows 10/11, Node.js 22 이상, PowerShell 7 (`pwsh`), Windows PowerShell 5.1, GitHub CLI `gh`가 필요합니다. ZIP을 풀면 `buzz-bridge` 폴더에서 실행합니다.

```powershell
cd <압축을_푼_폴더>\buzz-bridge
npm ci
npm test
gh auth status
npm run profile
node receive-mentions.mjs --github-check
node receive-mentions.mjs --agent-check --agent codex
```

기존 `%LOCALAPPDATA%\BuzzBridge\agent-a.identity.json`은 그대로 사용합니다. 신규 PC는 아래 절차로 자기 Agent를 초기화하고 커뮤니티와 채널에 등록합니다. 개인키는 생성한 Windows 사용자에게 DPAPI CurrentUser로 묶이므로 identity 파일을 PC 간 복사하지 않습니다.

Windows PowerShell 자식 프로세스의 모듈 autoload 문제는 `windows-env.mjs`에서 해결합니다. 상속된 `PSModulePath`의 대소문자 변형을 모두 지운 자식 환경을 만들고 `%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules`로 설정합니다. 부모 환경과 권한은 바꾸지 않습니다. 복호화 실패 시 키를 교체하지 말고 생성 계정, SystemRoot, Windows PowerShell을 확인합니다.

## 실행, 상태, 중지

```powershell
.\scripts\run.ps1 -Agent codex
.\scripts\status.ps1
.\scripts\stop.ps1
# 같은 명령의 npm 별칭
npm start
npm run status
npm stop
```

`run.ps1`는 PowerShell 7에서 숨긴 Node 호스트를 실행합니다. Windows PowerShell 5.1의 Restricted 정책은 변경하지 않습니다. stdout/stderr와 PID·instance 토큰은 `%LOCALAPPDATA%\BuzzBridge\runner`에 저장합니다. RUNNING은 프로세스 상태이며 서비스 연결 성공은 stdout의 `LISTENING`으로 확인합니다. `stop.ps1`는 토큰이 일치하는 호스트에 중지 파일을 전달하고 해당 호스트가 소유한 Bridge와 하위 에이전트만 종료합니다. 중복 실행은 차단합니다. 강제 종료는 실행 중 모델을 중단할 수 있으므로 다음 시작에서 needs_attention 또는 processing 레코드를 확인합니다.

STALE, launch.lock, processing 레코드는 자동 삭제하지 않습니다. 기록된 프로세스와 로그를 확인하고 보관 후 다시 시작하세요. 저장된 ready/알림 이벤트는 동일 서명 이벤트를 조회하여 복구합니다. 상태 디렉터리를 지우면 중복 억제 기록도 사라집니다.

기존 명령도 유지합니다.

```powershell
node receive-mentions.mjs --self-test
node receive-mentions.mjs --reply-once
node receive-mentions.mjs --listen --channels test,agent-reports
node receive-mentions.mjs --report-p001
node receive-mentions.mjs --codex-check
```

`--reply-once`는 새 OWNER 멘션 한 건을 처리합니다. 기본 무인수 명령은 수신 진단이며 자동 답변을 게시하지 않습니다. `--listen`은 실제 서명 멘션만 큐에 저장하고 순서대로 처리합니다. 첫 시작은 과거 메시지를 재생하지 않습니다. 페이지/큐 한도에 도달하면 커서를 건너뛰지 않고 오류로 종료합니다.

## 작업 JSON, 수정 보고와 질문

### 일반 JSON 보고서의 식별 계약

`--report <파일.json>`은 아래 형식의 일반 JSON 보고서도 받습니다. `payload`에는 작업 스키마와 무관한 JSON 객체, 배열, 문자열, 숫자, 불리언 또는 null을 넣을 수 있습니다. 일반 보고서는 GitHub 조회 없이 전달합니다.

```json
{
  "reportId": "release-2026-10",
  "threadId": "release-2026-10-thread",
  "revisionId": "v1",
  "submissionKey": "release-2026-10-submit-1",
  "previousRevisionId": null,
  "channel": "agent-reports",
  "payload": { "summary": "첫 보고", "metrics": { "count": 3 } }
}
```

- `reportId`: 영속 보고서 식별자입니다. 같은 보고서의 수정에서 유지합니다.
- `threadId`: 논리 스레드 식별자입니다. 최초 게시 후 Buzz의 실제 `rootEventId`와 연결되며, 다른 보고서·작성자·채널에서 재사용할 수 없습니다.
- `revisionId`: 보고서 안에서 불변인 버전 식별자입니다. payload를 바꾸면 새 값을 사용합니다. `previousRevisionId`에는 현재 버전 ID를 넣습니다. 첫 버전만 null입니다.
- `submissionKey`: 보고서 안에서 중복 제출을 식별하는 키입니다. 같은 키와 동일 버전을 재전송하면 추가 게시하지 않습니다. 같은 키의 내용·버전 변경은 오류입니다. 다른 제출 키로 이미 수락된 같은 버전을 보내도 추가 게시하지 않습니다.

네 식별자는 영문·숫자로 시작하고 영문·숫자·점·밑줄·콜론·하이픈을 포함하는 1~128자 문자열입니다. JSON 전체는 24,000바이트 이하이며 객체 키 순서는 payload의 SHA256 식별에 영향을 주지 않습니다. 버전의 payload와 이전 버전 연결은 변경할 수 없습니다. 과거 버전 재전송은 현재 버전을 되돌리지 않습니다.

상태는 `%LOCALAPPDATA%\BuzzBridge\reports`에 보고서 ID의 SHA256 파일명으로 저장합니다. `reportId`, `threadId`, `rootEventId`, `headRevisionId`, 버전별 원본 payload·SHA256·이전 버전·서명 이벤트·전달 상태, 제출별 키와 전달 이벤트 ID를 보관합니다. 최초 이벤트가 루트가 되고 수정 이벤트는 같은 루트의 NIP-10 답글이 됩니다. 작성자 공개키와 실제 채널 ID도 고정합니다.

게시 전 `pending` 이벤트를 저장하고, Buzz 수락 및 동일 서명 이벤트 읽기 확인 후 `delivery-confirmed`로 기록합니다. 응답을 잃으면 재시작 후 먼저 같은 이벤트 ID를 조회하여 복구합니다. 미확인 버전이 남아 있으면 다음 버전을 거부합니다. 프로세스별 보고서 잠금은 동시 제출을 차단하며, 비정상 종료 후 남은 잠금은 프로세스 상태를 확인한 뒤 복구해야 합니다. 이미 전달 확인된 제출은 로컬 상태로 중복을 억제하므로 상태 파일을 삭제하지 마세요.

`node --test test/report-workflow.test.cjs`는 제어된 Buzz 응답으로 실제 서명·루트·수정 메시지와 scratch 영속 상태를 검사합니다. 별도 Node 프로세스에서도 재전송을 검증합니다. 이 테스트는 실제 Buzz 서비스의 동작 증명이 아니며, 실서비스 검증은 AC 4의 별도 증거를 사용합니다.

### 기존 작업 보고서

`config/report.example.json`을 작업별 파일로 복사해 채우세요. 예제는 실제 완료 보고가 아닙니다.

```powershell
node receive-mentions.mjs --report config/report.example.json --preview-report
npm run report -- config/report.example.json
```

필수 필드는 `task_id`(P002 등 P + 3~6자리 숫자), `repository`(`seongwwww/sumtech`), `title`, `status`, `summary`, `changed_files`, `tests`입니다. status는 planned/in_progress/completed/blocked입니다. `issue`와 `pull_request`는 양의 번호 또는 null, `branch`는 보고할 브랜치, `source_state`는 실제 소스 상태입니다. 일반 보고의 기본 채널은 agent-reports, P001은 test입니다. 채널은 명시할 수 있습니다.

`tests`에는 실제 실행 명령, 상태와 근거를 적으세요. Bridge는 이 값을 보고하며 보고서 제출만으로 테스트를 실행하거나 PR/CI 성공을 증명하지 않습니다. 기존 P001의 수동 테스트 기록은 과거 사용자 보고로 유지합니다.

작업마다 루트 하나를 저장하고, 변경된 보고서는 같은 루트의 답글로 게시합니다. 렌더링 결과가 같은 보고서는 프로세스 재시작 후에도 중복 게시하지 않습니다. 서명 이벤트를 먼저 저장하고 게시·읽기를 확인한 뒤 posted로 기록합니다. 응답 유실 시 같은 이벤트 ID로 조회/재시도합니다. 작업을 다른 채널로 이동하지 않습니다. 보고서는 작업별 잠금을 사용하므로 멘션 listener를 켠 채 게시할 수 있습니다. 같은 작업의 동시 보고와 여러 멘션 실행기는 각각 잠금으로 직렬화합니다.

매핑과 보고서 정의는 `%LOCALAPPDATA%\BuzzBridge\tasks\Pxxx.json`에 저장합니다. 스레드 안에서 `@Agent-A 이 작업의 PR과 CI 상태는?` 또는 같은 채널에서 `@Agent-A P002 설명해줘`로 질문합니다. 다른 채널 작업의 컨텍스트는 불러오지 않습니다. 답변은 원래 루트와 멘션을 가리키는 NIP-10 스레드에 게시합니다.

질문 컨텍스트에는 저장된 작업, GitHub Issue 본문/상태/URL, PR 본문/파일/리뷰/체크 결과, 최근 workflow run, 같은 Buzz 스레드와 명시한 프로젝트 문서를 넣습니다. 문서는 `documents` 배열에 workspace 기준 상대 경로로 등록합니다. `.md`, `.txt`, `.json`만 허용하며 파일당 32 KB, 최대 10개입니다. 경로 이탈과 symlink 이탈은 차단하고, 누락된 파일은 오류로 표시합니다. 문서 본문과 SHA256을 함께 전달합니다. 기존 터미널 대화 기록을 붙이지 않으며, 별도 에이전트가 전달된 근거만으로 답합니다.

## Codex / Claude 선택

Codex가 기본입니다. 같은 CLI 명령에 `--agent claude`를 붙이거나 아래처럼 실행합니다.

```powershell
node receive-mentions.mjs --agent-check --agent claude
node receive-mentions.mjs --listen --channels test,agent-reports --agent claude
.\scripts\run.ps1 -Agent claude
```

Claude 네이티브 CLI를 PATH의 `claude.exe` 또는 npm 전역 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`에서 찾습니다. Claude 설치·로그인은 사용자가 기존 도구로 수행합니다. 만료된 OAuth는 `claude auth login`으로 사용자 계정에서 복구해야 합니다. 이 작업에서 유료 서비스 가입이나 재로그인을 대신하지 않습니다. 선택한 CLI가 없거나 인증/출력/시간 제한에 실패하면 답변을 게시하지 않고 실패를 기록합니다. 다른 에이전트로 조용히 전환하지 않습니다.

Codex는 별도 읽기 전용 임시 작업 공간에서 도구를 비활성화하고 실행합니다. Claude는 tools 빈 목록, strict MCP 빈 구성, 외부 설정 소스 배제, 세션 미저장으로 실행합니다. 두 에이전트는 최대 120초, 응답 12 KB로 제한합니다.

## GitHub 폴링 알림

```powershell
# 한 번 조회하여 baseline 또는 변경분 처리
node receive-mentions.mjs --watch-github --channels agent-reports --watch-config config/watch.example.json --once
# 멘션 답변과 알림을 같은 프로세스에서 처리
.\scripts\run.ps1 -Agent codex -WatchConfig config/watch.example.json
# 알림만 계속 실행
.\scripts\run.ps1 -Mode notifications -WatchConfig config/watch.example.json
```

설정은 repository, channel, interval_seconds(30~3600), tasks 배열입니다. 작업별 issue/pull_request를 입력합니다. 첫 조회는 현재 상태를 baseline으로 저장하고 과거 알림을 쏟아내지 않습니다. 이후 Issue/PR 상태·수정 시각, 리뷰/승인, PR 체크 결과, 병합과 최근 30개 workflow run 변화를 감지합니다. 실패한 CI도 그대로 알립니다. 작업 매핑이 있으면 같은 채널의 보고 스레드에 알리고, 매핑이 없거나 workflow 전체 이벤트이면 설정 채널에 게시합니다.

기준 상태와 미전송 서명 이벤트는 `%LOCALAPPDATA%\BuzzBridge\github-notifications.json`에 저장합니다. 재시작 시 먼저 미확인 이벤트를 조회/전송하고 같은 관측 상태를 다시 알리지 않습니다. 설정 변경은 기존 상태와 불일치 시 중단하므로 상태를 검토·보관한 뒤 새 baseline을 시작하세요. 폴링 간격 사이에 발생하고 다시 되돌아온 상태 및 조회 범위 밖의 오래된 run은 모두 복원하는 감사 로그가 아닙니다. 네트워크/429/5xx는 listener에서 재시도하며 인증/설정 오류는 표시 후 중지합니다.

`checkpoint`는 전체 GitHub 조회가 성공한 관측 회차·시각·스냅샷 해시입니다. 조회 실패 시 전진하지 않습니다. `observations`는 회차·소스 키·현재 값으로 만든 `observationId`와 관측 내용을 보존합니다. 같은 초 안에 같은 상태 변화가 다시 발생해도 회차가 다르므로 다른 이벤트가 됩니다. 최초 baseline은 알림을 만들지 않습니다. `pending`은 전송 대기 서명 이벤트이고, `deliveries`는 관측 ID에 연결된 별도 전달 기록입니다. 전송 시도 횟수는 POST 전에 저장하며, 정확한 이벤트 ID의 유효 서명을 Buzz에서 다시 조회한 경우에만 `delivery_confirmed` 및 `confirmationEventId`를 저장합니다. 관측이나 POST 성공 응답만으로 전달 완료로 표시하지 않습니다. 대기열을 비워도 관측·확인 기록은 남습니다. 기존 v1 상태는 보존하며 확장하지만, 과거에 지워진 완료 기록은 소급 생성하지 않습니다.

모호한 응답의 복구 정책은 `query-then-replay-identical-signed-event`입니다. 연결이 끊기거나 확인 조회가 지연되면 대기 상태를 유지하고 재시작 후 먼저 같은 ID를 조회합니다. 없으면 저장된 서명 이벤트를 그대로 다시 보냅니다. 따라서 POST가 여러 번 도착할 수 있으며, 중복 표시 억제는 Buzz가 동일 Nostr 이벤트 ID를 하나로 취급하는 데 의존합니다. ID 중복을 허용하는 서버에서 표시까지 정확히 한 번임을 보장하지 않습니다. `node --test test/notification-workflow.test.cjs`는 이 한계, 확인 조회 누락, 실패 후 재시도, 별도 Node 프로세스 재시작을 scratch 상태로 검증합니다. fixture 결과는 실서비스 변경 알림 전달 증거와 구분합니다.

## PC별 설치와 10명 롤아웃

기존 Agent-A PC는 설정 없이 계속 동작합니다. 새 팀원은 저장소를 clone한 뒤 자기 PC에서 아래를 실행합니다. npm.ps1 실행 정책 오류를 피하려면 `npm.cmd`를 사용합니다. 공개키는 Buzz 프로필의 HEX 공개키이며 개인키를 입력하지 않습니다.

```powershell
cd <압축을_푼_폴더>\buzz-bridge
npm.cmd ci
node scripts/setup-agent.mjs --name Agent-B --caller <본인_Buzz_HEX_공개키>
```

Agent-C~J도 각자 이름으로 실행합니다. setup은 기존 `config/local.json`을 덮어쓰지 않고 Agent별 identity를 생성합니다. 이후 관리자가 출력된 PUBLIC_KEY를 Community admin → Membership → Invite members → Add directly에 등록합니다. 팀원 PC에서 `npm.cmd run profile`을 실행한 다음, 관리자가 `agent-reports` → Manage members에서 이름을 검색해 채널에 추가합니다. 마지막으로 `npm.cmd start` 후 채널에서 진짜 @메뉴로 Agent를 선택해 질문합니다. 설정의 `allowed_callers`에 다른 팀원의 공개키를 추가하면 그 사람의 멘션도 허용합니다. 채널 OWNER는 기본으로 허용되며, 팀원도 Buzz 채널 멤버여야 메시지를 보낼 수 있습니다.

상태는 `npm.cmd run status`, 종료는 `npm.cmd stop`입니다. setup이 만든 개인 설정은 Git에서 제외됩니다. `BUZZ_BRIDGE_CONFIG` 환경변수로 다른 로컬 설정 파일 경로도 지정할 수 있습니다. GitHub 알림은 같은 작업을 여러 PC가 중복 전송하지 않도록 담당 PC 한 대(현재 Agent-A)에서만 `-WatchConfig`로 실행합니다. 다른 PC는 기본 `npm.cmd start`로 멘션만 수신합니다. 작업마다 담당 개발자가 자기 JSON을 보고하고 다른 Agent의 작업 ID와 중복되지 않게 관리합니다.

### 자격 증명과 설정 분리

Node.js 22+, PowerShell 7, GitHub CLI가 설치되지 않은 새 PC에서는 조직의 설치 정책에 따라 설치합니다. winget을 쓰는 경우 `winget install OpenJS.NodeJS.LTS`, `winget install Microsoft.PowerShell`, `winget install GitHub.cli` 후 새 터미널에서 `node --version`, `pwsh --version`, `gh --version`을 확인합니다. 이미 설치된 도구는 유지합니다. 압축본은 `npm.cmd ci`로 잠금 파일에 맞는 의존성을 설치합니다. Codex 또는 Claude는 기존 설치와 로그인을 사용하고, `--agent-check --agent codex` 또는 `--agent-check --agent claude`로 실제 인증 실행을 확인합니다. GitHub 조회는 `gh auth login` 후 `gh auth status`로 확인합니다. 로그인 토큰을 JSON에 넣지 않습니다.

소스 ZIP은 열 명에게 동일하게 전달합니다. 각자 Agent-A~J 중 겹치지 않는 이름을 배정받고 자기 Windows 계정에서 identity를 생성합니다. 공개키와 호출자 허용 목록은 설정이고, DPAPI로 보호된 개인키·CLI 로그인·GitHub 인증은 각 사용자 PC의 자격 증명입니다. 소스, 개인 설정, identity와 운영 상태를 분리합니다. JSON 예제에는 서비스 비밀번호나 토큰이 없습니다. 예제의 owner_public_key는 프로젝트 채널 소유자의 공개키이며 자격 증명이 아닙니다. 다른 커뮤니티에 배포할 때는 실제 채널 소유자 공개키로 바꿔야 합니다.

같은 Windows 계정에서 여러 개발자 구성을 시험할 때도 **각 구성의 데이터 폴더 전체를 분리**합니다. `-StateDirectory`만 나누면 보고서·알림·listener 상태가 분리되지 않습니다. 다음 명령은 압축을 푼 `buzz-bridge` 폴더에서 실행하며 `<...>`를 실제 값으로 바꿉니다. 외부 scratch 검증은 `$base`를 `$env:TEMP` 아래로 지정합니다.

```powershell
$base = Join-Path $env:LOCALAPPDATA 'BuzzBridgeDevelopers'
$dataB = Join-Path $base 'developer-B'
$dataC = Join-Path $base 'developer-C'
$configB = Join-Path $dataB 'config.json'
$configC = Join-Path $dataC 'config.json'
# setup 자식 프로세스에만 적용할 환경을 선택합니다. 기존 값은 마지막에 복원합니다.
$priorData = $env:LOCALAPPDATA
$priorConfig = $env:BUZZ_BRIDGE_CONFIG
try {
  $env:LOCALAPPDATA = $dataB; $env:BUZZ_BRIDGE_CONFIG = $configB
  node scripts/setup-agent.mjs --name Agent-B --caller <B의_Buzz_HEX_공개키>
  $env:LOCALAPPDATA = $dataC; $env:BUZZ_BRIDGE_CONFIG = $configC
  node scripts/setup-agent.mjs --name Agent-C --caller <C의_Buzz_HEX_공개키>
} finally {
  $env:LOCALAPPDATA = $priorData; $env:BUZZ_BRIDGE_CONFIG = $priorConfig
}
# 각 PUBLIC_KEY의 커뮤니티/채널 등록과 profile 게시를 위 절차대로 먼저 완료합니다.
# profile 명령에도 해당 LOCALAPPDATA와 BUZZ_BRIDGE_CONFIG를 선택해야 합니다.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run.ps1 -Config $configB -DataDirectory $dataB -Agent codex
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run.ps1 -Config $configC -DataDirectory $dataC -Agent claude
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/status.ps1 -DataDirectory $dataB
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/status.ps1 -DataDirectory $dataC
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/stop.ps1 -DataDirectory $dataB
# C는 계속 RUNNING이어야 합니다.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/status.ps1 -DataDirectory $dataC
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/stop.ps1 -DataDirectory $dataC
```

`run.ps1 -Config`는 해당 호스트와 자식 프로세스에만 `BUZZ_BRIDGE_CONFIG`를 전달합니다. `-DataDirectory`는 자식의 `LOCALAPPDATA`이며 identity, 보고서, 큐, 알림을 모두 그 아래에 둡니다. 기본 runner는 `<DataDirectory>\BuzzBridge\runner`입니다. `status`와 `stop`에도 같은 `-DataDirectory`를 사용하세요. 기존 `-StateDirectory` 옵션을 사용했다면 세 명령 모두 같은 경로로 지정해야 합니다. 인수 생략 시 기존 환경변수와 기본 경로를 유지합니다. 같은 데이터 폴더를 여러 구성에 사용하지 마세요.

상태 출력 예시는 `RUNNING pid=1234 agent=codex mode=listen`, `LOG=... ERRORS=...`, `CONFIG=... DATA=...`이며 종료 후 `STOPPED`입니다. 실제 연결은 stdout의 `LISTENING channels=test,agent-reports`로 확인합니다. 실행 직후 RUNNING만 보이면 stderr와 이후 status도 확인합니다. 신규 키가 `HTTP 403` 또는 채널 접근 오류를 내면 관리자가 **그 구성의 PUBLIC_KEY**를 커뮤니티와 두 채널에 등록했는지 확인합니다. 등록을 위해 기존 Agent의 identity를 복사하지 않습니다. DPAPI 오류는 생성한 Windows 계정으로 실행하는지, OAuth 오류는 선택한 CLI가 로그인되어 있는지 확인합니다. `npm ci` 실패는 네트워크/레지스트리 접근과 Node 버전을 확인합니다. STOPPED가 예상과 다르면 CONFIG/DATA 출력으로 다른 구성을 조작하지 않았는지 확인합니다.

`node --test test/rollout-kit.test.cjs`는 임시 폴더에서 10개의 별도 설정·DPAPI identity를 실제 생성하고 공개키 중복과 덮어쓰기 방지를 검사합니다. 두 실제 Windows 호스트에 fixture worker를 실행해 환경 분리, Codex/Claude 전달, B 종료 후 C 생존을 검사합니다. 이는 Buzz 연결 증거와 구분합니다.

`node scripts/verify-rollout.mjs`는 원본을 수정하지 않고 `%TEMP%\buzz-ac5-*`에 소스 ZIP을 만들고 깨끗한 폴더에 풀어 `npm.cmd ci`, 버전 확인, 위 테스트, 새 identity 두 개의 실제 Buzz run/status/stop을 수행합니다. 모든 로그·npm 캐시·설정·identity·증거는 scratch에만 생성됩니다. 필요한 도구는 사전 설치해야 하며 이미 설치된 전역 도구나 세션을 교체하지 않습니다. 새 키가 가입되지 않았다면 증거에 공개키와 서비스 오류를 남기고 `external_verification_blocked`(exit 2)로 종료합니다. 관리자 등록 전 fixture 성공을 실제 연결 성공으로 표시하지 않습니다. `evidence.json`에는 명령과 결과, 실서비스/fixture 구분, 한 PC의 환경, 산출물 선언·존재 여부 및 검증 전후 소스 해시가 들어갑니다. 다른 아홉 PC가 설치됐다는 뜻은 아닙니다.

프로젝트를 Paseo로 열면 루트 `paseo.json`의 Buzz 시작·상태·종료·테스트 명령을 사용할 수 있습니다. 기존 CLI 작업은 그대로 진행하며 완료 시 `npm.cmd run report -- <작업.json>`을 실행하면 됩니다. 기존 세션의 전체 대화를 가져오지 않습니다.

## 검증

```powershell
npm test
npm run verify:pc
npm run pack:source
```

`npm test`는 실제 구현 함수를 사용하는 로컬 서명 fixture로 보고서 루트/수정/중복, 답변 스레드, Issue/PR/CI/리뷰/문서 컨텍스트, 알림 종류와 장애 복구를 검증합니다. Windows DPAPI autoload roundtrip과 공백 경로의 run/status/stop도 검증합니다. 외부 GitHub 변경이나 사람의 멘션을 가짜로 만들지 않습니다.

`verify:pc`는 Codex·Claude 각각의 네이티브 실행 파일/버전과 실제 호출, test 채널의 일반 JSON 보고서·스레드 수정·중복 억제·읽기 확인, 실제 Issue #2와 문서를 사용한 컨텍스트 답변, GitHub 폴링과 Buzz 전달 확인을 실행합니다. test 채널에 검증 메시지가 남습니다. 폴링은 실제 GitHub 응답을 사용하되 scratch 체크포인트를 비워 기존 Issue를 다시 관찰하므로, 실행 중 새 GitHub 이벤트가 생성됐다는 증거는 아닙니다. PR/CI가 없으면 미확인으로 남기고 사람 멘션은 위조하지 않습니다.

실행 증거와 임시 상태는 콘솔의 `%TEMP%/buzz-ac4-*/evidence.json` 경로에만 저장합니다. 작업 폴더에는 쓰지 않으며, 실행 전후 소스 파일 해시를 비교합니다(`.git`, `node_modules` 제외). 기존 DPAPI identity는 scratch에서 잠시 사용한 뒤 삭제하고 증거에는 포함하지 않습니다. `docs/one-pc-verification.json`은 이전 실행의 기록이며 이번 실행 결과는 아닙니다. 두 에이전트의 필수 확인이 모두 성공해야 exit 0입니다. 인증 등 외부 조건이 부족하면 exit 2와 `external_verification_blocked`를 기록합니다. Claude OAuth 만료가 확인되면 계정 소유자가 로컬에서 인증을 복구해야 합니다.

`docs/rollout-checklist.csv`에는 개발자 10명의 미설치 슬롯을 제공합니다. 담당자를 지정하고 각 개발자의 작업 ID/Issue/PR와 검증 결과를 기록하세요. 운영자는 먼저 1-PC 테스트와 허용된 OWNER의 실제 멘션 답변을 확인하고, 팀원에게 JSON 예제와 보고/질문 절차를 공유합니다. 키·identity 파일은 전달하지 않습니다. 나머지 PC의 설치 결과는 실제 수행한 뒤 기록합니다.

`pack:source`는 `delivery.seed.json`의 소스·테스트·문서 목록으로 ZIP을 묶고 SHA256을 생성합니다. node_modules, 로컬 설정, identity, 상태와 로그는 포함하지 않습니다. ZIP은 `dist/buzz-bridge-source.zip`입니다. 실제 push/PR/CI 상태와 실행 기록은 GitHub에서 확인합니다.

알림 담당 PC에서는 `config/watch.example.json`을 `config/watch.local.json`으로 복사하고 담당 Issue/PR 번호를 넣으세요. `npm.cmd start`와 Paseo의 Buzz 시작은 이 로컬 파일이 있으면 알림도 함께 실행합니다. 파일이 없는 다른 PC에서는 멘션 수신만 실행합니다. `discover_new: true`는 baseline 이후 새로 관측한 저장소 Issue/PR도 알립니다. 제목에 P002 같은 작업 ID가 있고 해당 채널의 매핑이 있으면 그 작업 스레드에 연결합니다.
