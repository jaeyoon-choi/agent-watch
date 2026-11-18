# agent-watch

agent-watch는 Claude Code의 agent 목록에서 subagent 행을 한 줄 요약으로 바꾸는 mod다. mod는 Claude Code가 이벤트마다 부르는 함수(hook)를 등록해 화면과 동작을 바꾸는 플러그인이고, subagent는 메인 대화가 일을 맡겨 따로 돌리는 agent다. 각 행에는 진행 막대, 맡은 작업, 지금 하는 일을 요약한 문구, 경과 시간, tool 호출 수가 나온다.

![입력창 아래 agent 목록에 나온 subagent 행](docs/screenshot.png)

```
◯ 🤖 ███▎     ~40%  find fields  statusline 필드를 찾는 중  1m05s · 7 tools
◯ 🤖 ██▋      1/3   fix parser  tests/parse.test.ts 실패 원인 확인 중  42s · 12 tools
```

목록에서 agent를 골라 열거나 멈추는 키는 그대로 쓸 수 있다. `main` 행과 workflow(여러 agent를 스크립트로 묶어 돌리는 Claude Code 기능)가 띄운 agent의 행은 Claude Code 기본 모양으로 남는다.

## 동작 방식

mod는 `agent.spawn`, `tool.call`, `turn.complete` 이벤트에 hook을 걸어 subagent마다 맡은 작업, 최근 tool 호출, 끝난 시각을 기록한다. `ui.render`는 Claude Code가 화면의 한 부분을 그리기 전에 그 내용을 hook에 묻는 이벤트이고, `AgentRow`는 agent 목록의 한 행이다. mod는 `AgentRow`의 `ui.render`에 hook을 걸어 각 행의 내용을 기록으로 만든 한 줄로 바꾼다. mod의 기록이 바뀌면 Claude Code가 그 행을 다시 그린다. Claude Code는 5초마다 행을 다시 요청하기도 하므로 경과 시간이 계속 갱신된다.

요약 문구는 Anthropic의 작은 모델인 Haiku가 만든다. mod는 agent 하나에 대해 Haiku를 20초에 한 번까지만 부르고, 그 사이에 새 tool 호출이 없었으면 호출을 건너뛰므로 기다리기만 하는 agent에는 비용이 들지 않는다. Haiku는 진행률 추정치와 45자 이내의 한국어 문구를 `<퍼센트>|<문구>` 형식으로 답한다. 다른 언어로 받으려면 `hooks/register.ts`의 `SYSTEM`과 `REPLY_FORM`을 고친다.

agent가 자기 작업 목록(TaskCreate와 TaskUpdate, 또는 TodoWrite)을 쓰면 진행 막대는 전체 작업 가운데 끝난 작업 수를 `1/3`처럼 보인다. 작업 목록이 없으면 Haiku의 추정치를 `~40%`처럼 `~`를 붙여 보인다.

행이 좁아 한 줄이 다 들어가지 않으면 mod는 요약 문구부터 줄여서 경과 시간과 tool 호출 수가 보이게 한다. 요약 문구에 남은 칸이 8칸보다 적으면 문구를 아예 뺀다.

## 요구 사항

- Claude Code 2.1.326 이상이 필요하다. `AgentRow` 컴포넌트가 이 버전에 처음 들어왔고, 이 mod의 동작은 2.1.327에서 확인했다.
- 아래 상태 줄 대체 방식을 쓰려면 Linux나 macOS가 필요하다.

## 설치

터미널 세션의 입력창에 다음을 입력한다.

```
/plugin install agent-watch --marketplace jaeyoon-choi/agent-watch
```

marketplace를 추가할지 물으면 `y`로 답하고 설치 범위(scope)를 고른다. user 범위를 고르면 그 뒤에 시작하는 모든 세션에서 mod가 로드된다.

셸에서는 다음 명령으로 설치한다.

```
claude plugin install agent-watch --marketplace jaeyoon-choi/agent-watch
```

`/plugin`이 동작하지 않는 데스크톱 앱에서는 입력창 옆의 +를 누르고 Plugins를 연 뒤, Add marketplace에 `jaeyoon-choi/agent-watch`를 넣고 Add plugin을 누른다.

## 상태 줄 대체 방식

mod는 행에 보이는 데이터를 5초마다 `/tmp/claude-<uid>/agent-watch/<세션 id>.json` 파일에도 기록한다. `AgentRow`가 없는 버전에서는 `statusline/agent-rows.sh` 스크립트가 이 파일을 읽어 같은 행을 상태 줄 아래에 출력한다. 이 스크립트를 쓰려면 `jq`와 bash 3.2 이상이 필요하다.

```
curl -fsSL -o ~/.claude/agent-rows.sh https://raw.githubusercontent.com/jaeyoon-choi/agent-watch/main/statusline/agent-rows.sh
```

따로 쓰는 상태 줄이 없다면 `~/.claude/settings.json`에서 이 스크립트를 상태 줄 전체로 지정한다.

```json
"statusLine": {
  "type": "command",
  "command": "bash ~/.claude/agent-rows.sh",
  "refreshInterval": 5
}
```

이미 쓰는 상태 줄 스크립트가 있다면, 그 스크립트가 stdin으로 받은 JSON에서 세션 id를 꺼내 마지막에 행 스크립트를 부르게 한다.

```bash
session_id=$(jq -r '.session_id' <<< "$input")
bash ~/.claude/agent-rows.sh "$session_id"
```

agent가 일하는 동안 행이 갱신되도록 `refreshInterval`은 5초 이하로 둔다.

## 제약

- mod가 실행 중인 agent 목록을 얻는 `$.agent.list()`는 workflow가 띄운 agent를 돌려주지 않는다. mod는 그런 agent의 턴(응답 하나를 마칠 때까지의 실행)이 끝날 때 agent를 종료 상태로 바꾼다. 턴 종료 이벤트가 오지 않으면 마지막 tool 호출 뒤 10분이 지났을 때 종료 상태로 바꾼다.
- 세션마다 `/tmp/claude-<uid>/agent-watch/`에 작은 파일이 하나씩 남는다. 이 파일은 `/tmp`가 비워질 때까지 지워지지 않는다.

## 개발

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

마지막 명령은 이 폴더의 mod를 로드한 세션을 시작한다.
