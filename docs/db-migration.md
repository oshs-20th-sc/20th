# Firebase 스키마 이전 도구

`db/schema.js`가 저장 경로·필드명·구형 변환 규칙의 기준이다. 학생 화면에서 쓰는 객체 이름과 타자 점수 계산은 그대로 두고, Firestore에는 한글 필드와 행사별 하위 컬렉션을 쓴다.

## 순서

1. `firebase-tools`에 로그인한 관리자 계정과 `os20th` 프로젝트를 준비한다. 서비스 계정 키나 비밀번호를 저장소에 두지 않는다.
2. 이전과 새 경로 양쪽의 색인이 준비되도록 호환 인덱스를 먼저 배포한다.

```sh
firebase deploy --config db/firebase.transition.json --project os20th --only firestore:indexes
```

Firebase 콘솔에서 새 복합 색인이 모두 `READY`가 된 것을 확인한 다음, 호환 규칙을 배포한다. 이 규칙은 새 경로를 허용하고 이전 영문 루트의 쓰기는 중지한다. 이 시점부터 이전·검증이 끝날 때까지 구형 화면에서의 변경은 저장되지 않으므로 운영 중단 시간을 잡는다.

```sh
firebase deploy --config db/firebase.transition.json --project os20th --only firestore:rules
```

3. 구형 경로 쓰기가 잠긴 상태에서 저장소 밖의 새 파일명으로 전체 백업 및 읽기 전용 계획을 만든다.

```sh
node db/scripts/migrate-schema.mjs \
  --project os20th \
  --firebase-tools-dir /path/to/node_modules \
  --backup /private/path/os20th-before-v5.json
```

이 명령은 이전 루트 문서와 관리자 문서를 읽어 `0600` 권한의 비공개 백업 및 결과 보고서를 저장하고, 새 목적지와 필수 상위 문서의 생성·동일·보존 수를 출력한다. 백업에는 복구용 데이터와 원본 Firestore REST typed values 및 문서별 저장 시각이 포함된다. 기존 목적지에 다른 값이 있으면 중단한다. 백업 파일은 기존 파일을 덮지 않는다.

4. 계획과 백업을 검토한 뒤 같은 백업 경로로 `--apply`를 추가해 재실행한다. 이때 저장 시각과 전체 원본 스냅샷이 첫 계획과 같아야 한다. 원본이 달라졌다면 새 백업 파일명으로 계획을 다시 만들고 검토한다. 데이터는 새로운 기능별 경로에 생성되고 기존 원본은 그대로 남는다.

```sh
node db/scripts/migrate-schema.mjs \
  --project os20th \
  --firebase-tools-dir /path/to/node_modules \
  --backup /private/path/os20th-before-v5.json \
  --apply
```
5. 새 클라이언트를 작업 브랜치에 푸시하고 Pages 빌드가 새 경로를 사용하는지 확인한다. 실제 관리 화면에서 조회·접수·검수·삭제를 확인하고, 로그인 후 별도의 읽기 전용 검증을 실행한다.

```sh
node db/scripts/migrate-schema.mjs \
  --project os20th \
  --firebase-tools-dir /path/to/node_modules \
  --backup /private/path/os20th-before-v5.json \
  --verify
```

`--verify`는 원본별 저장 시각과 변환된 새 문서의 전체 필드를 비교한다. 빠진 문서나 값이 다른 문서가 있으면 실패한다.

6. 새 클라이언트의 실제 조회·쓰기 확인 후 최종 규칙을 배포한다. 최종 규칙은 새 경로만 허용한다. 호환 인덱스는 구형 데이터 정리를 마칠 때까지 유지한다.

```sh
firebase deploy --config db/firebase.json --project os20th --only firestore:rules
```

그 다음 명시적인 정리 계획을 조회한다. 이전 시 백업 이후 원본이 수정·추가되지 않았고 새 문서가 원본과 일치하는 경우에만 대상 원본을 표시한다.

```sh
node db/scripts/migrate-schema.mjs \
  --project os20th \
  --firebase-tools-dir /path/to/node_modules \
  --backup /private/path/os20th-before-v5.json \
  --cleanup-legacy --cutover-verified
```

위 명령은 기본적으로 삭제 없는 계획만 만든다. 컷오버를 확인하고 계획을 검토한 뒤에만 `--apply`를 추가해 이전 루트 문서를 제거한다. 각 연결 문서 묶음은 원본·새 문서를 트랜잭션에서 다시 읽고, 비공개 백업의 저장 시각과 raw 필드, 전체 변환 값이 모두 일치할 때 삭제한다. 바뀐 문서, 추가·누락된 문서, 값이 다른 새 문서가 있으면 정리를 중단한다. 이전 `admins/{uid}` 복사본은 검증 후 정리되지만 새 `관리자/{uid}` 역할 문서는 남는다. Firebase Auth 계정은 이 DB 스크립트에서 삭제하지 않는다.

7. 이전 루트 정리가 끝나면 마지막으로 canonical 인덱스를 배포해 호환 인덱스만 정리한다.

```sh
firebase deploy --config db/firebase.json --project os20th --only firestore:indexes
```

## 복구

이전 전 전체 백업은 기존 필드와 ID를 담아 기존 버전 백업 복구 경로로 읽힌다. 복구 도구는 같은 문서가 이미 있고 값이 다르면 덮어쓰지 않고 멈춘다. 이전 후 스키마 v5 백업은 한글 필드명과 논리 컬렉션 키로 저장되며 복구 시 `db/schema.js`의 경로 매핑을 거친다. 복구는 빠진 필수 상위 문서를 만들고, 이미 있는 운영 메타데이터는 보존한다. Auth 계정과 비밀번호는 포함하지 않는다.

검증은 로컬 모의 Firestore로 실행한다.

```sh
node tests/schema-migration.mjs
```

이전 대상은 저장소의 허용 목록에 없는 루트 컬렉션, 지원하지 않는 Firestore 값 형식, 정수 안전 범위를 넘는 값이 있으면 쓰기 전에 중단한다. 이를 발견하면 백업을 보관하고 스키마에 명시적 변환을 추가한 다음 계획을 다시 확인한다.

## 2026-11-16 운영 전환 결과

운영 프로젝트 `os20th`의 기본 STANDARD 데이터베이스에서 전환을 완료했다.

- 기존 문서 33개를 옮기고 콘솔 탐색용 상위 문서 2개를 생성했다. 원본 점수·본문·참가 정보·내용 해시·시간 값과 원래 Firestore 값 타입을 보존했다.
- 새 인덱스 10개가 모두 READY가 된 뒤 기존 경로의 쓰기를 잠갔다. 최종 비공개 백업 → 이전 → 35개 문서 전체 대조 → 작업 브랜치 Pages 배포 → 실제 관리자 로그인·조회 → 최종 규칙 → 기존 사본 정리 순서로 적용했다.
- 기존 영어 컬렉션의 사본 33개와 이전 인덱스 10개를 정리했다. 최상위 컬렉션은 `관리자`, `운영설정`, `타자대회`, `글쓰기` 네 개다.
- 정리 후 원본 문서 33개를 새 위치에서 다시 대조했고, v5 백업 33개 문서의 형식 검증도 통과했다. 상위 문서 2개는 복원 도구가 별도로 재구성한다. 비공개 원본·새 백업과 이전 보고서는 저장소 밖에 보관했다.
- 실제 운영 DB에서 임시 관리자 권한으로 타자 12종, 글 8종, 휴지통 8종, 글 이력 1종의 조회 조합을 검사했다. 익명 타자 기록 조회는 거절됐다. 운영 DB에 검증용 글이나 타자 결과를 생성하지 않았다.
- 실제 배포 사이트에서 임시 관리자 로그인, 타자 순위, 글 목록, 운영 설정 화면을 확인했다. 접수·중복 거절·백업·삭제 후 재참여·글 승인·공개·휴지통·복원·페이지 이동은 실제 Auth/Firestore 에뮬레이터와 Chrome 데스크톱 통합 검사로 확인했다.
- 모바일 검사는 실행하지 않았다. 기존 UI 회귀, 코덱, 삭제 로직, 이전·복원 안전성, 규칙·경로 범위·호환 규칙·인덱스 표기 검사도 통과했다.
- Firebase Authentication 계정은 삭제하지 않았다. 임시 관리자 계정과 새 구조의 역할 문서는 유지하며 운영 전에 함께 제거할 대상으로 남겼다. 비밀번호는 저장소에 넣지 않았다.

변경된 저장 경계는 `db/schema.js`, `db/store.js`, `db/database.js`, `db/public.js`, `db/firebase.js`이며, 모든 학생·관리자 진입점의 JS 캐시 버전을 함께 갱신했다. 입력 엔진과 채점 계산은 수정하지 않았다. `main`은 변경하지 않았다.
