// 회사 그룹웨어의 API 요청을 기록하는 분석용 스크립트
// 실행: node tools/capture.js  → 열린 Chrome 창에서 직접 로그인 후 달력 화면 이동, 끝나면 창 닫기
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'capture.jsonl');
const SENSITIVE = /sign\/(auth|otp|nonce|unlock_screen)|verify-token/;

(async () => {
  fs.writeFileSync(OUT, '');
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  context.on('response', async (res) => {
    const req = res.request();
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    const url = req.url();
    const entry = { method: req.method(), url, status: res.status() };
    if (SENSITIVE.test(url)) {
      entry.note = '로그인 요청 - 본문 기록 안 함';
    } else {
      entry.postData = req.postData() || undefined;
      try {
        const body = await res.text();
        entry.body = body.length > 2000000 ? body.slice(0, 2000000) + '...(truncated)' : body;
      } catch (e) { entry.body = '(읽기 실패)'; }
    }
    fs.appendFileSync(OUT, JSON.stringify(entry) + '\n');
    console.log(res.status(), req.method(), url);
  });

  await page.goto('https://gw.linkgenesis.co.kr/ngw/app/#/sign');
  await page.bringToFront();
  console.log('브라우저에서 로그인 후 근무 달력 화면으로 이동하고, 이전/다음 달을 눌러보세요. 끝나면 창을 닫으세요.');
  // 창(탭)을 닫거나 브라우저가 종료되면 끝냄
  await new Promise((r) => {
    browser.on('disconnected', r);
    page.on('close', r);
  });
  console.log('기록 완료:', OUT);
  await browser.close().catch(() => {});
  process.exit(0);
})();
