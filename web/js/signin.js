// Moved out of app.js by #200 (part 4/4 of #165). The sign-in page is self-
// contained: it talks to the API directly and never reaches into the rest of
// the Wiring section, so it can leave without a circular import on either
// side.

/**
 * The sign-in page.
 *
 * What was here before told people to "open the link printed by the server",
 * which is not a sign-in -- it is an instruction to go and find a URL somewhere
 * else. A hub you cannot log into from its own front page is a hub people paste
 * tokens around for.
 *
 * What is offered depends on what the hub actually supports, asked rather than
 * assumed: a button that leads nowhere is worse than no button.
 */
export async function showSignIn() {
  let methods = { mode: 'unknown', githubOAuth: false, acceptsToken: true };
  try { methods = await (await fetch('/api/auth-methods')).json(); } catch { /* offline */ }

  const oauth = methods.githubOAuth;
  document.body.innerHTML = `
    <div class="signin">
      <img src="/logo.jpg" alt="Squad Hub">
      <h1>Squad Hub</h1>
      <p class="signin-sub">See and control your Squad sessions.</p>

      ${oauth ? `
        <a class="signin-btn" href="/auth/github/login">
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
              0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01
              1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95
              0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27
              2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15
              0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0
              .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          Sign in with GitHub
        </a>
        <div class="signin-or">or</div>
      ` : ''}

      <form class="signin-form" id="tokenForm">
        <label for="tokenInput">${oauth ? 'Use a token instead' : 'Sign in with a token'}</label>
        <input id="tokenInput" type="password" placeholder="paste a token"
               autocomplete="off" spellcheck="false">
        <button class="primary" type="submit">Continue</button>
      </form>

      <p class="signin-hint">${signInHint(methods.mode)}</p>
      <p class="err" id="signinErr" hidden></p>
    </div>`;

  document.getElementById('tokenForm').onsubmit = async (e) => {
    e.preventDefault();
    const token = document.getElementById('tokenInput').value.trim();
    if (!token) return;
    // Check the token BEFORE storing it. Saving a bad one and then failing
    // every request leaves people staring at an empty hub with no explanation.
    try {
      const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(r.status === 403
          ? (body.error || 'That account is not permitted to use this hub.')
          : 'That token was not accepted.');
      }
      localStorage.setItem('squad-hub-token', token);
      location.replace('/');
    } catch (err) {
      const el = document.getElementById('signinErr');
      el.hidden = false;
      el.textContent = err.message;
    }
  };
}

function signInHint(mode) {
  if (mode === 'github') return 'Any GitHub token works — <code>gh auth token</code> prints one.';
  if (mode === 'entra') return 'Use a Microsoft Entra ID access token for this hub.';
  return 'Use the token printed by <code>squad-hub serve</code>.';
}
