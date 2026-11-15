# Agent Review Desk Cloud 운영 가이드

> **미출시, 막혀 있음.** 유료 팀 기능은 아직 계획 중입니다. 서버와 이를 쓰는 명령은 개발자용 스위치 `ARD_UNRELEASED_CLOUD=1`이 없으면 실행되지 않습니다. 이 문서는 출시 때를 위해 보관하며, 지금 사용할 수 있는 것을 설명하지 않습니다.

> 이 문서는 [영어 원문](cloud-selfhosting.md)의 한국어 번역입니다. 내용이 다르면 영어 원문이 기준입니다.

클라우드 서버는 유료 **Team** 티어입니다. 계정 시스템, 동기화된 세션을 담는 팀 워크스페이스, 역할, 싱글 사인온(SSO), 결제로 구성됩니다.
`@ard/cloud`와 `@ard/billing` 위에서 동작하는 Next.js 앱(`apps/cloud`)입니다.

> **현재 상태(솔직하게).** 서버, CLI 명령(`ard login` / `sync`), 역할, SSO, 두 결제 연동은 모두 구현되어 테스트를 마쳤습니다.
> 실제 서버, 실제 CLI, 서명된 웹훅, 실제 OIDC 리다이렉트를 함께 돌리는 end-to-end 실행도 포함됩니다.
> 아직 하지 **못한** 것은 Paddle/Dodo 계정으로 하는 실제 결제와, 실제 로그인 제공자(IdP)로 하는 실제 로그인입니다.
> 7장이 그 확인 체크리스트입니다.

## 1. 필요한 것

- Node.js 22.13 이상.
- **영구 디스크**가 있는 서버와 **단일 인스턴스**. 데이터는 SQLite(컨트롤 DB 하나와 조직별 파일 하나)입니다.
  단순하고 빠르지만 여러 서버가 공유할 수는 없습니다. 확장하려면 저장소 계층의 Postgres 구현이 필요하며, 아직 만들지 않았습니다.
- 앞단의 HTTPS(Caddy, nginx, 플랫폼 로드밸런서 등). Paddle과 모든 로그인 제공자가 HTTPS를 요구합니다.
- 로그인용 OpenID Connect 제공자(Google 가능), 그리고 Paddle 및/또는 Dodo Payments 계정.

## 2. 빌드와 실행

```bash
git clone https://github.com/Trapa-Eureka/agent-review-desk.git
cd agent-review-desk
pnpm install
pnpm build
# 환경 변수를 설정한 뒤(apps/cloud/.env.example 참고):
pnpm --filter @ard/cloud-web start        # 127.0.0.1:4780에서 대기. 앞단에 HTTPS 프록시를 두세요
```

환경 변수가 불완전하면 서버가 홈 화면에 설정 문제를 한꺼번에 보여 주고, 안전하지 않은 조합(평문 http 공개 주소, 실제 호스트에서의 개발용 로그인)으로는 실행을 거부합니다.

## 3. 환경 변수

모든 변수는 `apps/cloud/.env.example`에 설명되어 있습니다. 핵심은 `ARD_CLOUD_SECRET`, `ARD_CLOUD_BASE_URL`, `ARD_CLOUD_DATA_DIR`,
`ARD_CLOUD_LOGIN_*` 제공자, `ARD_PADDLE_*` / `ARD_DODO_*` 그룹입니다.

리버스 프록시 뒤에서는 `ARD_CLOUD_TRUST_PROXY=1`(프록시 단계 수. CDN과 프록시가 있으면 `2`)을 설정해, 요청 제한이 실제 클라이언트 주소를 기준으로
계산되게 하세요. 주소는 `X-Forwarded-For`의 **오른쪽 끝**에서 읽습니다. 본인의 프록시가 붙인 값이 거기 있고, 그보다 왼쪽에 클라이언트가 쓴 값은
무시되므로 클라이언트가 자신의 요청 제한 키를 고를 수 없습니다. 설정하지 않으면 이 헤더를 무시하고 모든 클라이언트가 하나의 버킷을 공유합니다
(위조에는 안전하지만, 한 클라이언트가 많이 요청하면 모두의 로그인 허용량이 소진될 수 있습니다). 프록시가 없을 때는 절대 설정하지 마세요.

## 4. 로그인

OpenID Connect 제공자에 다음 리디렉션 URI를 등록하세요: `https://<호스트>/api/auth/callback`. 사용자는 그 제공자로 로그인하며,
계정은 제공자가 주는 고유 subject id로 식별되고 **인증된(verified)** 이메일 주소가 필요합니다.

조직은 자체 **싱글 사인온**을 추가할 수 있습니다(Settings > Single sign-on, 소유자만). Okta, Microsoft Entra ID, Google Workspace, Auth0 등
모든 OpenID Connect 제공자를 쓸 수 있습니다. SAML은 지원하지 않습니다. 회사의 SSO로 로그인한 사람은 **그 조직에 한정된 계정**이 됩니다.
같은 이메일의 개인 계정과 합쳐지지 않으며(회사 IdP가 남의 이메일 주소를 주장해 계정을 가로챌 수 있기 때문입니다),
다른 조직을 만들거나 참여할 수 없습니다.

## 5. 결제

요금제는 조직당 월 **Team** 구독 하나입니다. **코드에는 가격이 없습니다.** 서버는 아래에서 만드는 상품에 붙은 가격을 그대로 청구하도록
결제 제공자에게 요청할 뿐이므로, 금액은 제공자 대시보드에서 정하고 나중에 바꿀 수 있습니다. 가격을 바꿔도 **새 구독자에게만** 적용되고,
기존 구독은 시작할 때의 가격을 유지합니다(두 제공자 모두 같습니다).

두 연동 모두 기본값이 **샌드박스 / 테스트 모드**이고, 두 제공자 모두 샌드박스와 라이브는 완전히 분리되어 있습니다(상품, 가격, 키, 웹훅, 시크릿).
항상 샌드박스에서 먼저 만들고 테스트한 뒤, 라이브에서 같은 설정을 반복하세요(5.3절). 제공자는 하나만 설정해도 되고 둘 다 설정해도 됩니다.
설정된 제공자마다 소유자에게 결제 버튼이 보입니다.

아래 내용은 각 제공자의 공식 문서(2026년 11월)로 확인했습니다. 대시보드는 바뀔 수 있으며, 확인하지 못한 라벨은 그렇다고 적어 두었습니다.
화면이 다르면 제공자의 최신 문서를 따르세요.

### 5.1 Paddle

#### 1단계. 샌드박스 계정 만들기

샌드박스 계정은 이미 라이브 계정이 있어도 별도로 만들어야 합니다: <https://sandbox-vendors.paddle.com/signup>. 인증이 필요 없고 실제 돈이
오가지 않습니다. 5.1절의 모든 작업은 먼저 **샌드박스** 대시보드에서 합니다.

#### 2단계. 상품 만들기

1. **Paddle > Catalog > Products**로 가서 **New product**를 누릅니다.
2. **Product name**(필수, 예: `Agent Review Desk Team`), **Tax category**(`SaaS` 선택. `standard`와 `saas`는 모든 계정에 있습니다),
   선택 항목인 **Description**을 입력합니다.
3. **Save**를 누릅니다.

#### 3단계. 월 가격 만들기(서버가 사용하는 것)

1. 상품을 열고 **Prices** 영역에서 **New price**를 누릅니다.
2. 입력합니다.
   - **Base price**(필수): 금액과 통화(처음에는 USD).
   - **Tax**: **Default**로 둡니다(계정의 판매세 설정을 따릅니다. 4단계 참고).
   - **Type**: **Recurring**. 일회성(One-time) 가격은 구독을 만들지 않아서 청구가 시작되지 않습니다.
   - **Billing period**: **Monthly**.
   - **Trial period**: 체험 기간이 없으면 `0`. 무료/유료 체험은 선택이며, 서버는 `trialing`을 유료 접근으로 취급합니다.
   - **Price name**(체크아웃과 청구서에 표시됨. 예: `Team, monthly`)과 내부 설명.
3. **Save**를 누릅니다.
4. **가격** id를 복사합니다. 가격 옆의 `...` 메뉴에서 **Copy price ID**를 선택하면 되고, `pri_`로 시작합니다.
   상품 id(`pro_...`)를 복사하면 **안 됩니다**. 이 값을 `ARD_PADDLE_PRICE_ID`에 넣습니다.

서버는 이 가격을 수량 1로 구매하므로, 조직 하나 = 구독 하나입니다.

#### 4단계. 세금 표시 방식 정하기(계정당 한 번)

**Paddle > My account > Settings > Sales tax**에서 가격을 세금 제외, 세금 포함, 고객 위치에 따라 자동 중 하나로 정합니다. Tax가 `Default`인
가격에 적용됩니다. Paddle이 merchant of record이므로 판매세/VAT는 Paddle이 처리합니다.

#### 5단계. API 키 만들기

1. **Paddle > My account > Settings > Authentication**의 **API keys** 탭에서 **New API key**를 누릅니다.
2. 이름과 설명을 입력하고 **권한(permissions)**을 고르고 **만료일**을 정합니다. **Rotatable**은 Paddle API나 시크릿 매니저로 키를 교체할
   계획이 아니면 끄세요(만든 뒤에는 바꿀 수 없습니다).
3. **Save**한 뒤 키를 복사합니다. **한 번만 보여 줍니다.** 잃어버리면 폐기하고 새로 만들어야 합니다.

선택할 권한(이것만 부여): `transaction.write`(체크아웃 생성), `customer_portal_session.write`(결제 포털 열기), 그리고 읽기 권한
`transaction.read`, `price.read`, `product.read`, `customer.read`, `subscription.read`. Write는 read를 포함합니다. 서버 로그에 Paddle의
`forbidden`(403)이 보이면 키에 권한이 빠진 것이니, 키를 수정해서 추가하세요(그 키로 Paddle의 API root를 호출하면 `caller.permissions`로 확인됩니다).

샌드박스 키는 `pdl_sdbx_apikey_...`, 라이브 키는 `pdl_live_apikey_...` 형태입니다. 샌드박스 키를 라이브 API에 쓰면(또는 반대로) `forbidden`으로
실패합니다. 키는 `ARD_PADDLE_API_KEY`에 넣고 서버 쪽에만 두세요. **만료일을 캘린더에 적어 두세요.** 키가 만료되면 결제 버튼이 실패하기 시작합니다.

#### 6단계. 클라이언트 측 토큰 만들기

같은 화면의 **Client-side tokens** 탭에서 **New client-side token**을 눌러 이름을 입력하고 **Save**한 뒤, 옆의 `...` 버튼에서 **Copy**를 선택합니다.
샌드박스 토큰은 `test_`, 라이브 토큰은 `live_`로 시작합니다. `ARD_PADDLE_CLIENT_TOKEN`에 넣습니다. 웹 페이지에 노출해도 안전합니다(체크아웃 열기와
가격 미리보기만 가능). **여기에 API 키를 넣으면 절대 안 됩니다.**

#### 7단계. 도메인 승인과 기본 결제 링크(default payment link) 설정

Paddle은 승인된 도메인에서만 체크아웃을 열며, 기본 결제 링크가 없으면 트랜잭션 생성이 실패합니다. 이 서버의 체크아웃 페이지는
`https://<호스트>/pay`입니다.

1. **Paddle > My account > Settings > Website approval > Add a new domain**: 호스트 이름을 입력하고 **Submit for approval**을 누릅니다.
   샌드박스는 즉시 승인되고, 라이브는 심사에 며칠이 걸립니다.
2. **Paddle > Checkout > Checkout configuration**의 **Default payment link**에 `https://<호스트>/pay`를 입력하고 **Save**합니다.
   반드시 `https`이고 본인 도메인이어야 하며 **`localhost`는 안 됩니다.** 라이브 계정에서는 호스트가 승인된 도메인과 정확히(또는 `www.` 형태로)
   일치해야 합니다. `example.com`이 승인되어 있어도 `app.example.com`은 따로 승인받아야 합니다.

공개 호스트가 아직 없을 때의 테스트: 기본 결제 링크는 `localhost`가 될 수 없으므로, 로컬 서버에 공개 https 주소를 주는 터널(Cloudflare Tunnel,
ngrok 등)을 쓰고 그 주소를 `ARD_CLOUD_BASE_URL`과 위 두 설정에 쓰세요. 체크아웃 자체는 샌드박스에서 `localhost`에서도 열립니다.

`/pay` 페이지는 `cdn.paddle.com`에서 Paddle.js를 불러오고 Paddle의 체크아웃 프레임을 삽입하므로, 이 페이지에만 `*.paddle.com`을 허용하는 더 넓은
Content-Security-Policy가 적용됩니다. Paddle은 공식 CSP 목록을 공개하지 않아서 이 한 페이지에 한해 일부러 넓은 패턴을 썼습니다.
**샌드박스에서 체크아웃이 열리는지 직접 확인**하고, 가능하면 좁히세요.

#### 8단계. 웹훅(notification destination) 만들기

1. **Paddle > Events > Notifications > New destination**.
2. **Description**: 아무거나(예: `Agent Review Desk`). **Notification type**: **Webhook**.
3. **URL**: `https://<호스트>/api/webhooks/paddle`. **API version**은 기본값, 사용 유형은 **platform**(실제 이벤트만)으로 둡니다.
4. **Events**: 다음 8개를 정확히 선택합니다: `subscription.created`, `subscription.activated`, `subscription.trialing`,
   `subscription.updated`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`.
   (다른 이벤트는 응답만 하고 무시합니다. 전체 선택도 동작하지만 불필요한 요청만 늘어납니다.)
5. **Save destination**.
6. 만든 destination을 다시 열어(`...` 메뉴 > **Edit destination**) **Secret key**(`pdl_ntfset_...`)를 복사해 `ARD_PADDLE_WEBHOOK_SECRET`에 넣습니다.

나중에 destination을 삭제했다가 다시 만들지 마세요. **새** 시크릿이 생겨서 서버를 업데이트하기 전까지 모든 전송이 검증에 실패합니다.
활성 destination은 최대 10개입니다. 샌드박스와 라이브의 destination은 각자 시크릿이 있습니다.

#### 9단계. 샌드박스에서 테스트

샌드박스 값으로 서버를 재시작하고 7장을 따라 하세요. Paddle 체크아웃에서는 테스트 카드 `4242 4242 4242 4242`, 미래의 아무 만료일,
보안 코드 `100`, 본인 소유의 이메일, 유효한 아무 국가와 우편번호를 쓰면 됩니다. Billing 화면이 1분 안에(웹훅이 도착하면) **Team**으로
바뀌어야 합니다. Paddle의 알림 시뮬레이터로 엔드포인트에 이벤트를 재전송해 볼 수도 있습니다.

### 5.2 Dodo Payments

#### 1단계. 두 가지 모드 이해하기

대시보드 사이드바에 **Live Mode** 스위치가 있습니다. 테스트 모드와 라이브 모드는 **상품, API 키, 웹훅**이 서로 분리되어 있습니다(상품은 나중에 테스트에서
라이브로 복사할 수 있습니다). 사업자 프로필, 은행 계좌, 인증 서류는 공유됩니다. 한 모드의 키를 다른 모드의 호스트(`test.dodopayments.com` /
`live.dodopayments.com`)에 쓰면 401이 반환됩니다. 서버는 `ARD_DODO_ENV`로 호스트를 고릅니다.

테스트 모드에서 알아둘 두 가지: 테스트 모드에서 만든 구독은 취소하기 전까지 **계속 갱신**됩니다(테스트 키로 Update Subscription API에
`status: "cancelled"`를 보내 취소). 그리고 테스트 모드도 **실제 이메일**을 보냅니다(제목 앞에 `[TEST MODE]`가 붙음). 본인 소유 주소를 쓰세요.

가입할 때 계정 유형을 고릅니다: **Individual**(크리에이터 또는 개인사업자. 문서상 회사 등록이나 사업자 세금 ID가 필요 없음) 또는
**Registered Entity**. 인증은 라이브 결제에만 필요하고(5.3절), 테스트 모드는 바로 쓸 수 있습니다.

#### 2단계. 구독 상품 만들기

1. 대시보드를 **테스트 모드**로 바꾸고 **Products**를 열어 새 상품을 만듭니다(정확한 버튼 이름은 문서에서 확인하지 못했습니다).
2. **Pricing Type**: **Subscription**(Single Payment도, Usage Based Billing도 아님).
3. 항목을 입력합니다.
   - **Product Name**(필수, 예: `Agent Review Desk Team`). 설명, 이미지, 브랜드는 선택입니다.
   - **Tax Category**(필수): `SaaS`를 고릅니다.
   - **Price**(필수): 월 금액과 통화. 0이 아닌 구독 가격의 최소는 1.00 USD입니다. 입력 단위(달러인지 센트인지)는 문서에서 확인하지 못했으니,
     저장 후 대시보드에 표시되는 금액을 확인하세요.
   - **Repeat payment every**: `1` **Month**.
   - **Subscription Period**(필수): 전체 기간. **20년**(최대값이자 권장값)으로 하세요. **이 값이 결제 주기와 같으면 구독이 한 번 청구된 뒤 만료**되어,
     첫 달 이후 접근이 끊깁니다.
   - **Trial Period Days**(필수): 체험이 없으면 `0`.
   - **Card-optional at $0 Price**, 애드온, 권한(entitlements)은 비워 둡니다. **Discount**, **Trial Amount**, **Tax Inclusive Pricing**은
     필요한 경우가 아니면 기본값으로 둡니다.
4. 저장합니다. **Products > View Details**에서 상품 id(`pdt_...`)를 복사해 `ARD_DODO_PRODUCT_ID`에 넣습니다.

서버는 이 상품을 수량 1로 구매하므로, 조직 하나 = 구독 하나입니다.

#### 3단계. API 키 만들기

1. **Developer > API Keys > Create New Key**(우선 테스트 모드에서).
2. **Key Name**을 입력하고 리소스별 접근을 **None / Read / Write**로 정합니다. 체크아웃과 포털 호출에 어떤 리소스가 필요한지 문서에 나와 있지 않으니,
   **Payments: Write**, **Subscriptions: Read**, **Products: Read**, **Customers: Write**로 시작하고 나머지는 **None**으로 두세요.
   서버 로그에 Dodo의 401/403이 보이면 **Edit Permissions**를 열어 오류가 가리키는 권한을 추가하세요.
3. **IP Allowlist**는 선택입니다(최대 20개의 주소 또는 CIDR). 서버의 발신 주소가 고정이 아니라면 비워 두세요. 잘못된 허용 목록은 모든 결제 버튼을 실패시킵니다.
4. 만들고 키를 즉시 복사합니다. **한 번만 보여 줍니다.** 테스트 키는 `dodo_test_`, 라이브 키는 `dodo_live_`로 시작합니다. `ARD_DODO_API_KEY`에 넣습니다.

#### 4단계. 웹훅 엔드포인트 만들기

1. **Developer > Webhooks > Add endpoint**.
2. **Endpoint URL**: `https://<호스트>/api/webhooks/dodo`(https 필수).
3. **Events**: `subscription` 아래에서 다음 10개를 정확히 선택합니다: `subscription.active`, `subscription.renewed`, `subscription.unpaused`,
   `subscription.plan_changed`, `subscription.past_due`, `subscription.on_hold`, `subscription.paused`, `subscription.cancelled`,
   `subscription.expired`, `subscription.failed`.
   **목록을 비워 두면 안 됩니다.** 그러면 Dodo가 모든 이벤트를 보냅니다. `subscription.updated`나 `subscription.update_payment_method`도 추가하지 마세요.
   서버가 쓰지 않으며, 분류할 수 없는 구독 이벤트는 접근 없음으로 처리될 수 있습니다.
4. **Create endpoint**를 누르고, **Overview** 탭에서 서명 시크릿(`whsec_...`)을 복사해 `ARD_DODO_WEBHOOK_SECRET`에 넣습니다. 같은 탭에
   **Rotate secret**이 있으며, 이전 시크릿은 24시간 동안 유효합니다.

Dodo는 전송마다 30초의 제한 시간과 최대 8번의 재시도를 두며, 엔드포인트의 **Logs** 탭에서 이벤트를 재전송할 수 있습니다. **Testing** 탭에는
**Send example**이 있습니다.

#### 5단계. 리턴 주소

서버는 체크아웃을 만들 때 리턴 주소(Billing 페이지)를 함께 보내고, Dodo는 결제 후 구매자를 그 주소로 돌려보내며 URL에 상태를 붙입니다.
서버는 그 URL을 접근 권한의 근거로 쓰지 않습니다. 플랜을 바꾸는 것은 서명된 웹훅뿐입니다. 문서에는 체크아웃 세션의 허용 도메인 설정이 나와 있지 않습니다.
리턴 주소 때문에 체크아웃이 거부되면 Dodo 지원팀에 서버가 보낸 주소를 알려 주고 문의하세요. 체크아웃 링크는 한 번만 쓸 수 있고 24시간 뒤 만료됩니다.

#### 6단계. 테스트 모드에서 테스트

테스트 값으로 서버를 재시작하고 7장을 따라 하세요. Dodo 테스트 문서에 있는 테스트 카드 번호를 쓰세요. Billing 화면이 **Team**으로 바뀌는지 확인하고,
끝나면 테스트 구독을 취소하세요(1단계 참고).

### 5.3 라이브 전환(두 제공자 공통)

샌드박스 / 테스트 모드에서 한 번 끝까지 돌려 본 뒤에만(7장) 진행하세요. 라이브 계정은 별개이므로 모든 것을 다시 만들어야 합니다.

**두 제공자 모두 공개 웹사이트가 필요**하며, 그 사이트에 가격, **이용약관(Terms of Service)**, **개인정보처리방침(Privacy Policy)**,
**환불 및 해지 정책**, 연락 수단이 있어야 합니다. **이 서버는 그 페이지들을 제공하지 않으니, 직접 사이트에 게시해야 합니다.** 사이트의 가격은
카탈로그와 일치해야 합니다. 두 제공자 모두 라이브 결제를 허용하기 전에 사이트를 심사합니다.

**Paddle**

1. 계정 인증을 완료합니다: **Paddle > Get started > Verify your account**(관리자가 진행). Paddle은 개인 정보(생년월일과 집 주소 포함), 사업체의
   법적 이름과 주소, 웹사이트, 판매할 것을 묻습니다. 인증은 보통 약 10분 걸리지만 며칠이 걸릴 수도 있습니다. Paddle은 *사업체* 정보를 요구하며,
   사업자 등록이 없는 사람에게 무엇이 적용되는지는 문서에 없습니다. 의존하기 전에 Paddle에 문의하세요. 사업자 등록이나 세금 징수가 필요한지는 본인과
   세무사가 판단할 일입니다.
2. 각 도메인을 **Website approval**에 제출합니다(라이브 심사는 며칠 걸리며 인증과 병행할 수 있습니다).
3. **라이브** 대시보드에서 상품과 월 가격을 다시 만들고(id가 다르니 대응표를 적어 두세요), **라이브** API 키와 **라이브** 클라이언트 측 토큰(`live_...`),
   **라이브** notification destination(새 시크릿)을 만듭니다.
4. 도메인이 승인되면 라이브 **기본 결제 링크**를 `https://<호스트>/pay`로 설정합니다.
5. 은행 정보를 추가합니다: **Business account > Payouts > Payout settings**.
6. 라이브 값 **네 가지**(API 키, 가격 id, 클라이언트 토큰, 웹훅 시크릿)와 함께 `ARD_PADDLE_ENV=production`으로 설정하고 재시작한 뒤, 직접 실제 구매를
   한 번 해 봅니다(100% 할인 코드를 쓰면 무료입니다).

**Dodo Payments**

1. 계정 유형에 맞는 양식을 대시보드에서 완료합니다. Individual은 **Product Information > Identity Verification(KYC) > Bank Verification**이고,
   Registered Entity는 사업자 인증이 추가됩니다. Product Information에서는 공개 사이트(위의 페이지 포함)와 판매할 것에 대한 설명을 묻습니다.
   KYC는 정부 발급 사진 신분증과 셀피(3회 시도)이며, 신분증은 Dodo의 허용 국가 목록에 있는 국가의 것이어야 합니다. **시작하기 전에 본인 국가가 그 목록에
   있는지 확인하세요.** 은행 계좌 명의는 인증된 신분과 일치해야 합니다. 심사는 보통 영업일 기준 1~3일이며, 지급(payout)에는 모니터링 심사 완료도 필요합니다.
2. 대시보드를 **라이브 모드**로 바꾸고 테스트 모드의 상품을 복사(또는 다시 생성)합니다. 새 `pdt_` id를 적어 둡니다.
3. **라이브** API 키와 **라이브** 웹훅 엔드포인트(새 `whsec_` 시크릿)를 만듭니다.
4. 라이브 값 **세 가지**(API 키, 상품 id, 웹훅 시크릿)와 함께 `ARD_DODO_ENV=live_mode`로 설정하고 재시작한 뒤, 직접 실제 구매를 한 번 해 봅니다.

전환한 뒤에는 본인의 테스트 구매를 제공자 대시보드에서 취소하고 환불하세요.

### 5.4 결제가 접근 권한이 되는 과정

소유자가 Billing 화면에서 **Pay with Paddle / Dodo Payments**를 누르면, 서버는 일회용 무작위 값을 넣어 체크아웃을 만들고
제공자가 구독 웹훅에 그 값을 돌려줍니다. **결제를 조직에 연결하는 것은 그 값이며, 웹훅 본문에서 읽은 id가 아닙니다.**
웹훅은 받은 바이트 그대로 검증하고(Paddle: `ts:본문`의 HMAC-SHA256, Dodo: Standard Webhooks), 멱등하며(재전송해도 바뀌지 않음),
순서가 뒤바뀌어도 안전합니다(오래된 이벤트가 새 이벤트를 덮어쓰지 않음). 서명이 올바르지 않으면 400을 반환하고 아무것도 바꾸지 않습니다. 두 조직이 같은 구독을 주장하는 경우는 **409**로 응답해(제공자 대시보드에 전송 실패로 보임) 감사 로그에 남기므로 사람이 확인하게 됩니다. **교체된 옛 구독**에 대한 늦은 이벤트는 팀이 지금 결제 중인 구독을 끄지 못합니다.

접근 규칙: `active` / `trialing`이면 유료 기능이 켜지고, 결제 실패 시 첫 실패로부터 **7일** 동안 접근이 유지되며, 해지한 구독은 결제 기간이 끝날 때까지
유지되고, 일시중지되었거나 완료되지 않은 구독은 꺼집니다. 접근이 끊기면 **업로드와 리뷰는 멈추지만, 이미 동기화된 내용은 계속 읽을 수 있습니다.**
구독이 끊겨도 데이터를 볼모로 잡지 않습니다.

환불, 차지백, 플랜 변경은 제공자의 대시보드에서 처리하며 구독 업데이트로 서버에 전달됩니다.

## 6. 운영

- **`ARD_CLOUD_DATA_DIR`을 백업하세요**(서버를 멈추거나 SQLite의 `.backup` 사용). 계정, 결제 상태, 동기화된 모든 세션이 들어 있습니다.
- **로그**: 거부된 웹훅은 이유를 기록하며(본문은 절대 기록하지 않음), 예상치 못한 오류는 스택 트레이스와 함께 기록됩니다.
- **헬스 체크**: 가동 확인에는 `GET /api/health`를 쓰세요.
- **시크릿 교체**: `ARD_CLOUD_SECRET`을 바꾸면 저장된 SSO 클라이언트 시크릿을 읽을 수 없게 되며, 소유자는 SSO 설정을 다시 저장하라는 안내를 받습니다.
  그 밖에는 의존하는 것이 없습니다.
- **제한**: 업로드당 이벤트 500개 / 4 MiB, 조직별 저장 용량 한도(기본 1 GiB), 업로드 및 로그인 요청 제한(메모리 기반이라 재시작하면 초기화됩니다).
- **보존**: 동기화된 데이터는 삭제할 때까지 유지됩니다. 자동 만료는 아직 없습니다.

## 7. 첫 실서비스 테스트(직접 확인할 것)

1. 샌드박스: 로그인하고 조직을 만든 뒤 **Pay with Paddle**을 눌러 샌드박스 구매를 완료하고, Billing 화면이 1분 안에(웹훅) **Team**으로 바뀌는지 확인합니다.
   그다음 프로젝트에서 `ard login`과 `ard sync`를 실행합니다.
2. 결제 포털에서 해지하고, "paid until period end"가 표시되며 그때까지 동기화가 계속 되는지 확인합니다.
3. Dodo도 제공한다면 테스트 모드로 같은 과정을 반복합니다.
4. 실제 로그인 제공자를 설정하고, (선택) 한 조직의 SSO도 시크릿(프라이빗) 브라우저 창에서 설정해 봅니다.
5. 그런 다음에만 라이브 자격 증명과 승인된 도메인으로 `ARD_PADDLE_ENV=production` / `ARD_DODO_ENV=live_mode`로 전환합니다.

## 8. 보안 모델 요약

- 세션: 무작위 id를 해시로만 저장하며, 쿠키는 `HttpOnly`, `SameSite=Lax`, 그리고 https에서는 `Secure`(및 `__Host-` 접두사)입니다.
- 상태를 바꾸는 요청은 이 사이트에서 온 것이어야 합니다. `Sec-Fetch-Site`가 그렇다고 말해야 하고 **동시에** `Origin`이 있으면 일치해야 합니다
  (브라우저가 아닌 클라이언트는 `Origin`만으로 판단).
- 로그인은 시작한 브라우저에 묶입니다(로그인 `state`를 담은 수명이 짧은 쿠키). 그래서 콜백 링크를 남에게 보내 그 사람의 브라우저를
  공격자 계정으로 로그인시키는 공격(로그인 CSRF)이 통하지 않습니다.
- 페이지 헤더에는 일부러 `form-action` 지시어를 두지 않았습니다. Chrome이 폼 전송 뒤의 리디렉션에도 이를 적용하는데, 로그인, SSO, 결제가
  폼 전송 후 다른 사이트로 리디렉션되는 흐름이기 때문입니다.
- API 토큰(`ard_...`)은 무작위로 생성되고 해시로 저장되며, 한 번만 보여 주고, 폐기할 수 있으며, 요청마다 조직 멤버십을 확인합니다.
- 서버는 고객이 입력한 URL(SSO 발급자)을 가져옵니다. 이때 비 https, 리다이렉트, 과도하게 큰 응답, 공개 주소가 아닌 모든 주소를 거부합니다
  (IPv6는 전역 유니캐스트만 허용하므로 IPv4 매핑 주소의 모든 표기도 막힙니다). 그리고 이름을 다시 조회하지 않고 검사한 바로 그 주소로 연결합니다
  (DNS 리바인딩 방지).
- ID 토큰은 제공자가 공개한 키로 서명된 RS256 또는 ES256이어야 하며, `none`과 HMAC 알고리즘은 거부합니다.
- 조직마다 세션이 **자체 SQLite 파일**에 있어서, 어떤 쿼리도 조직 경계를 넘을 수 없습니다.
- 세션은 처음 업로드한 멤버의 것이고, 세션 전체에 대한 리뷰 결정은 업로드할 수 없으며, 업로드된 텍스트는 서버에서 다시 마스킹(redaction)합니다.

## 9. 알려진 한계

- SQLite, 단일 인스턴스(1장 참고). SAML 없음. 발신 이메일 없음: 초대 링크는 직접 복사해서 전달합니다.
- 조직당 단일 Team 플랜이며 좌석(seat)별 과금은 아직 없습니다.
- 위험한 작업의 사전 승인(로컬 훅)은 여전히 로컬에서만 동작합니다. 클라우드 워크스페이스의 승인은 끝난 세션에 대한 리뷰이며,
  실행 중인 에이전트를 막는 관문이 아닙니다.
- 자동 데이터 삭제와 내보내기 도구는 아직 없습니다.
