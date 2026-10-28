# 작업 보고

기존 개발 도구와 세션을 유지한다. Buzz는 작업 단위의 보고와 질문에 사용한다.

작업을 완료하면 담당 작업 ID(P001, P002 등), 요약, 변경 파일, 실제 테스트 결과, Issue/PR 번호를 작업 JSON에 기록한다. 예제는 `buzz-bridge/config/report.example.json`, 설치와 실행 방법은 `buzz-bridge/README.ko.md`에 있다.

로컬 Agent가 커뮤니티와 채널에 등록되어 있으면 `npm.cmd --prefix buzz-bridge run report -- <작업.json>`으로 보고한다. listener를 종료할 필요는 없다. 같은 작업의 수정 보고는 같은 JSON의 내용을 바꾸어 제출한다. 보고 실패는 코드 작업 완료와 구분하고 사용자에게 알린다. 완료되지 않은 테스트나 push/PR/CI를 성공으로 적지 않는다.

전체 대화, 개인키, 토큰, identity 파일은 보고서나 Git에 포함하지 않는다. 다른 개발자의 작업 ID를 새 작업에 재사용하지 않는다. Buzz 질문에 답하는 Bridge의 읽기 전용 실행과 실제 코드 변경 작업을 구분한다.
