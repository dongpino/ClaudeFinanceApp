# ClaudeFinanceApp — 프로젝트 지침

## Git 브랜치 워크플로 (필수)

- **작업 브랜치는 `staging`** — 모든 코드 변경/커밋/푸시는 `staging`에서 한다.
- **`master`는 merge 시에만 체크아웃** — 배포용 브랜치. `git checkout master → git merge staging → git push` 목적으로만 잠시 전환하고, 직접 커밋하지 않는다.
- **세션 종료 시 `staging`으로 복귀** — 어떤 작업이든 끝난 뒤에는 `staging` 브랜치에 머무른 상태로 종료한다(merge를 위해 master로 갔더라도 마지막에 `git checkout staging`).
