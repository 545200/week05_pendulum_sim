// 功能级验收：报错捕获 + 像素级行为验证（摆长联动/复位/双摆/预设/持久化/数值稳定性）
const http = require('http');
const FILE_URL = process.argv[2];
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJSON('/json/list');
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text);
  };

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __evalError: r.exceptionDetails.text + ' | ' + (r.exceptionDetails.exception?.description || '') };
    return r.result.value;
  };

  const PROBE = `(() => {
    const c = document.getElementById('stage');
    const ctx = c.getContext('2d');
    const k = c.width / 900;
    const px = c.width / 2, py = 80 * k;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sx = 0, sy = 0, n = 0, lit = 0;
    for (let y = 0; y < c.height; y += 2) {
      for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        const a = d[i + 3];
        if (a > 60) lit++;
        if (a > 200 && Math.hypot(x - px, y - py) > 42 * k) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (b > 140 && (g > 120 || r > 140)) { sx += x; sy += y; n++; }
        }
      }
    }
    if (!n) return { lit, bobs: 0 };
    const bx = sx / n, by = sy / n;
    return {
      lit, bobs: n,
      x: +(bx / k).toFixed(1), y: +(by / k).toFixed(1),
      angleDeg: +(Math.atan2(bx - px, by - py) * 180 / Math.PI).toFixed(1),
      radius: +(Math.hypot(bx - px, by - py) / k).toFixed(1)
    };
  })()`;

  await new Promise((r) => (ws.onopen = r));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: FILE_URL });
  await sleep(600);
  await evaluate('try{localStorage.clear()}catch(e){}');
  await send('Page.reload', {});
  await sleep(1500);

  const R = { steps: [] };
  R.steps.push({ step: '1) 冷启动渲染', probe: await evaluate(PROBE) });

  await evaluate(`(()=>{const s=document.getElementById('lenSlider');s.value=350;s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(400);
  R.steps.push({ step: '2) 摆长→350px', label: await evaluate(`document.getElementById('lenVal').textContent`), probe: await evaluate(PROBE) });

  await evaluate(`document.getElementById('tabDouble').click()`);
  await sleep(900);
  R.steps.push({
    step: '3) 切换到双摆',
    activeTab: await evaluate(`document.querySelector('.tab.active').textContent`),
    probe: await evaluate(PROBE),
  });

  await sleep(3000);
  R.steps.push({ step: '4) 双摆持续运行 3s（数值发散检测）', probe: await evaluate(PROBE) });

  await evaluate(`document.querySelector('[data-g="1.62"]').click()`);
  await sleep(1000);
  R.steps.push({
    step: '5) 切换到月球预设',
    gravLabel: await evaluate(`document.getElementById('gravVal').textContent`),
    activeCap: await evaluate(`document.querySelector('.cap.active').textContent`),
  });

  // 切回单摆后校验"重置"是否把摆球精确送回 45°
  await evaluate(`document.getElementById('tabSingle').click()`);
  await sleep(300);
  await evaluate(`document.getElementById('resetBtn').click()`);
  await sleep(80);
  R.steps.push({ step: '6) 单摆模式下点击重置', probe: await evaluate(PROBE) });

  await evaluate(`(()=>{const s=document.getElementById('lenSlider');s.value=275;s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(500);
  await send('Page.reload', {});
  await sleep(1200);
  R.steps.push({
    step: '7) 刷新后持久化恢复',
    lengthLabel: await evaluate(`document.getElementById('lenVal').textContent`),
    activeTab: await evaluate(`document.querySelector('.tab.active').textContent`),
    gravLabel: await evaluate(`document.getElementById('gravVal').textContent`),
    stored: await evaluate(`localStorage.getItem('week05.pendulum.state.v1')`),
  });

  R.exceptions = exceptions.filter(Boolean);
  R.consoleErrors = consoleErrors;
  console.log(JSON.stringify(R, null, 2));
  ws.close();
  process.exit(0);
})();
