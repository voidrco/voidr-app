import voidrIcon from '../../assets/icon.svg';

export const authCallbackPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Continue in Voidr</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; background: #050607; color: #ededed; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: center; }
    main { width: min(100%, 440px); }
    .brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 36px; font-size: 28px; font-weight: 650; letter-spacing: -1px; }
    .brand svg { width: 48px; height: 48px; }
    h1 { margin: 0 0 16px; font-size: clamp(26px, 5vw, 34px); line-height: 1.2; letter-spacing: -1px; }
    p { margin: 0 auto; max-width: 350px; color: #a5a5a5; font-size: 15px; line-height: 1.6; }
    button { margin-top: 32px; padding: 12px 28px; border: 0; border-radius: 6px; background: #ededed; color: #050607; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #d5d5d5; }
    button:focus-visible { outline: 2px solid #ededed; outline-offset: 5px; }
    small { display: block; margin-top: 16px; color: #858585; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <div class="brand" aria-label="Voidr">${voidrIcon}<span>voidr</span></div>
    <h1>Continue in Voidr.</h1>
    <p>Your sign-in is being completed in the desktop app. You can return to it now.</p>
    <button type="button" id="close">Close this tab</button>
    <small id="hint">This window is no longer needed.</small>
  </main>
  <script>
    history.replaceState(null, '', '/callback');
    document.getElementById('close').addEventListener('click', () => {
      window.close();
      document.getElementById('hint').textContent = 'You can close this tab manually and return to Voidr.';
    });
    setTimeout(() => window.close(), 1800);
  </script>
</body>
</html>`;
