# Sumtech 협업 환경

개발자마다 Windows에서 기존 Codex CLI 또는 Claude Code와 Buzz Bridge를 실행합니다. Buzz에는 작업별 보고와 질문·답변을 남기고, GitHub Issue·PR·Actions와 저장소 문서를 작업 근거로 사용합니다.

- [설치와 팀원 PC 연결](buzz-bridge/README.ko.md)
- [작업 보고 JSON 예제](buzz-bridge/config/report.example.json)
- [10명 배포 체크리스트](buzz-bridge/docs/rollout-checklist.csv)
- [현재 PC의 실환경 검증 기록](buzz-bridge/docs/one-pc-verification.json)

현재 Agent-A PC에서 연결과 보고·답변을 검증했습니다. 다른 PC는 각자 Agent를 초기화하고 커뮤니티·채널에 등록해야 합니다. Claude 답변은 해당 PC의 Claude 로그인이 필요합니다.

Paseo에서 이 폴더를 열면 `Buzz 시작`, `Buzz 상태`, `Buzz 종료`, `Bridge 테스트` 스크립트를 실행할 수 있습니다. PowerShell에서는 다음 명령을 사용합니다.

```powershell
npm.cmd --prefix buzz-bridge start
npm.cmd --prefix buzz-bridge run status
npm.cmd --prefix buzz-bridge run report -- C:\path\P002.json
npm.cmd --prefix buzz-bridge stop
```

보고서에는 실제 수정 파일·테스트 결과·Issue/PR 링크를 기록합니다. 답변은 기존 CLI 대화를 재사용하지 않고, 별도 프로세스에서 해당 작업 근거를 읽어 생성합니다.

Bridge를 한 번 설치한 뒤 여러 프로젝트를 등록할 수 있습니다. 각 프로젝트에서 GitHub 저장소·Buzz Relay 주소·채널을 지정하고 `connect`로 접근을 확인한 다음 `start`로 실행합니다. 프로젝트별 작업 기록과 수신기 상태는 분리되며, 기존 sumtech는 `legacy` 프로필로 유지됩니다. [프로젝트 추가·선택 명령](buzz-bridge/README.ko.md#저장소커뮤니티채널만-지정하는-빠른-등록)을 참고하세요.
