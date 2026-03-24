(function () {
  const SESSION_MINUTES = 30;
  const INTERNAL_BUCKET = 'internal-files';
  const MEMBERSHIP_SUCCESS_PARAM = 'checkout';

  const state = {
    supabase: null,
    activityBound: false,
    logoutTimer: null,
    authReady: false,
  };

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const fmt = (value) => {
    if (!value) return '—';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  };

  function setText(el, text, hidden = false) {
    if (!el) return;
    el.textContent = text || '';
    el.hidden = hidden;
  }

  function showError(form, text) {
    const error = form?.querySelector('.form-error, .auth-error');
    if (error) {
      error.hidden = false;
      error.textContent = text;
    }
  }

  function clearFormState(form) {
    if (!form) return;
    form.querySelectorAll('.form-error, .auth-error, .form-success').forEach((node) => {
      node.hidden = true;
      node.textContent = '';
    });
  }

  function setupMenu() {
    const menuToggle = document.querySelector('.menu-toggle');
    const nav = document.querySelector('.main-nav');
    if (menuToggle && nav) {
      menuToggle.addEventListener('click', () => nav.classList.toggle('show'));
    }
  }

  async function setupContactForm() {
    const form = document.querySelector('.contact-form[data-ajax="true"]');
    if (!form) return;
    const notice = document.querySelector('.form-success');
    const errorBox = document.querySelector('.form-error');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (notice) notice.hidden = true;
      if (errorBox) errorBox.hidden = true;
      const button = form.querySelector('button[type="submit"]');
      const original = button ? button.textContent : '';
      if (button) {
        button.disabled = true;
        button.textContent = 'Sending...';
      }
      try {
        const response = await fetch(form.action, {
          method: 'POST',
          body: new FormData(form),
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('Submission failed');
        form.reset();
        if (notice) {
          notice.hidden = false;
          notice.textContent = 'Sent successfully.';
        }
      } catch (error) {
        if (errorBox) {
          errorBox.hidden = false;
          errorBox.textContent = 'Message could not be sent right now. Please email admin@pkuco.org directly.';
        }
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = original || 'Send Message';
        }
      }
    });
  }

  function getSupabase() {
    if (state.supabase) return state.supabase;
    if (!window.supabase || !window.PUCO_SUPABASE_URL || !window.PUCO_SUPABASE_ANON_KEY) {
      return null;
    }
    state.supabase = window.supabase.createClient(window.PUCO_SUPABASE_URL, window.PUCO_SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    return state.supabase;
  }

  async function getSession() {
    const supabase = getSupabase();
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session || null;
  }

  async function getCurrentUser() {
    const session = await getSession();
    return session?.user || null;
  }

  async function signOutAndRedirect() {
    const supabase = getSupabase();
    if (supabase) {
      await supabase.auth.signOut();
    }
    window.location.href = '/login/';
  }

  function resetAutoLogoutCountdown() {
    clearTimeout(state.logoutTimer);
    state.logoutTimer = setTimeout(async () => {
      alert('You have been logged out due to inactivity.');
      await signOutAndRedirect();
    }, SESSION_MINUTES * 60 * 1000);
  }

  function bindSessionWatch() {
    if (state.activityBound) return;
    state.activityBound = true;
    ['click', 'keydown', 'mousemove', 'scroll', 'touchstart'].forEach((eventName) => {
      window.addEventListener(eventName, resetAutoLogoutCountdown, { passive: true });
    });
    resetAutoLogoutCountdown();
  }

  function requireSupabaseMessage(container, text) {
    if (!container) return;
    container.innerHTML = `<div class="panel"><h3>Supabase is not configured yet.</h3><p>${text}</p></div>`;
  }

  async function fetchMyProfile() {
    const supabase = getSupabase();
    const user = await getCurrentUser();
    if (!supabase || !user) return null;
    const { data, error } = await supabase.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function ensureMemberProfile(user, tier = null) {
    const supabase = getSupabase();
    const existing = await fetchMyProfile();
    if (existing) return existing;
    const payload = {
      user_id: user.id,
      email: user.email,
      full_name: user.user_metadata?.full_name || '',
      role: 'member',
      membership_status: 'pending',
      membership_tier: tier,
    };
    const { error } = await supabase.from('profiles').insert(payload);
    if (error) throw error;
    return await fetchMyProfile();
  }

  async function setupInternalLogin() {
    const form = $('#internal-login-form');
    if (!form) return;
    const supabase = getSupabase();
    if (!supabase) {
      showError(form, 'Supabase is not configured yet. Please add your project URL and anon key in config.js.');
      return;
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormState(form);
      const button = $('button[type="submit"]', form);
      const original = button?.textContent || 'Login';
      if (button) {
        button.disabled = true;
        button.textContent = 'Logging in...';
      }
      try {
        const email = form.email.value.trim().toLowerCase();
        const password = form.password.value;
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const profile = await fetchMyProfile();
        if (!profile || !['admin', 'internal'].includes(profile.role)) {
          await supabase.auth.signOut();
          throw new Error('This account is not an internal account.');
        }
        window.location.href = '/portal/internal/';
      } catch (error) {
        showError(form, error.message || 'Incorrect email or password.');
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = original;
        }
      }
    });
  }

  async function uploadInternalAttachment(file, messageId) {
    const supabase = getSupabase();
    const path = `${messageId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error } = await supabase.storage.from(INTERNAL_BUCKET).upload(path, file, {
      cacheControl: '3600',
      upsert: false,
    });
    if (error) throw error;
    return path;
  }

  async function getSignedFileUrl(path) {
    const supabase = getSupabase();
    const { data, error } = await supabase.storage.from(INTERNAL_BUCKET).createSignedUrl(path, 60 * 10);
    if (error) throw error;
    return data?.signedUrl || '';
  }

  async function renderInternalPortal() {
    const root = $('#internal-portal');
    if (!root) return;
    const supabase = getSupabase();
    if (!supabase) {
      requireSupabaseMessage(root, 'Open site/config.js, fill in your Supabase URL and anon key, then refresh the page.');
      return;
    }

    const user = await getCurrentUser();
    if (!user) {
      window.location.href = '/internal-login/';
      return;
    }

    let me;
    try {
      me = await fetchMyProfile();
    } catch (error) {
      requireSupabaseMessage(root, error.message || 'Could not load profile.');
      return;
    }

    if (!me || !['admin', 'internal'].includes(me.role)) {
      await supabase.auth.signOut();
      window.location.href = '/internal-login/';
      return;
    }

    bindSessionWatch();

    const accountsQuery = supabase
      .from('profiles')
      .select('*')
      .in('role', ['admin', 'internal'])
      .order('created_at', { ascending: true });
    const messagesQuery = supabase
      .from('internal_messages')
      .select('*')
      .order('created_at', { ascending: false });

    const [{ data: accounts = [], error: accountsError }, { data: inbox = [], error: messagesError }] = await Promise.all([
      accountsQuery,
      messagesQuery,
    ]);

    if (accountsError) {
      requireSupabaseMessage(root, accountsError.message);
      return;
    }
    if (messagesError) {
      requireSupabaseMessage(root, messagesError.message);
      return;
    }

    const downloadableMessages = await Promise.all(
      inbox.map(async (item) => {
        if (!item.attachment_path) return { ...item, signedUrl: '' };
        try {
          const signedUrl = await getSignedFileUrl(item.attachment_path);
          return { ...item, signedUrl };
        } catch {
          return { ...item, signedUrl: '' };
        }
      })
    );

    root.innerHTML = `
      <div class="dashboard-shell">
        <aside class="dashboard-sidebar panel">
          <span class="tag">${me.role === 'admin' ? 'Administrator' : 'Internal member'}</span>
          <h2>${me.full_name || me.email}</h2>
          <p>${me.email}</p>
          <p class="small-note">Automatic logout after ${SESSION_MINUTES} minutes of inactivity.</p>
          <button class="btn btn-secondary logout-btn" type="button">Logout</button>
        </aside>
        <div class="dashboard-main">
          <section class="panel">
            <p class="eyebrow">Inbox</p>
            <h3>Files and notices from the administrator</h3>
            <div class="inbox-list">
              ${downloadableMessages.length ? downloadableMessages.map((item) => `
                <article class="message-card">
                  <div class="message-top">
                    <strong>${escapeHtml(item.title || 'Untitled')}</strong>
                    <span>${fmt(item.created_at)}</span>
                  </div>
                  <p>${escapeHtml(item.body || '')}</p>
                  ${item.signedUrl ? `<div class="attachment-box">${item.attachment_type && item.attachment_type.startsWith('image/') ? `<img src="${item.signedUrl}" alt="${escapeHtml(item.attachment_name || 'attachment')}" class="attachment-preview" />` : ''}<a class="text-link" href="${item.signedUrl}" download="${escapeHtml(item.attachment_name || 'attachment')}">Download ${escapeHtml(item.attachment_name || 'attachment')}</a></div>` : ''}
                  <p class="small-note">From: ${escapeHtml(item.from_email || 'PUCO admin')}</p>
                </article>
              `).join('') : '<p>No files or messages yet.</p>'}
            </div>
          </section>

          <section class="panel">
            <p class="eyebrow">Security</p>
            <h3>Change your password</h3>
            <form id="change-password-form" class="stack-form compact-form">
              <input type="password" name="newPassword" placeholder="New password" minlength="8" required />
              <button class="btn btn-primary" type="submit">Update password</button>
              <p class="form-success small-note" hidden></p>
              <p class="form-error small-note" hidden></p>
            </form>
          </section>

          ${me.role === 'admin' ? `
          <section class="panel">
            <p class="eyebrow">Create account</p>
            <h3>Add a new internal member</h3>
            <form id="create-internal-account" class="stack-form compact-form">
              <input type="text" name="name" placeholder="Member name" required />
              <input type="email" name="email" placeholder="Initial username / email" required />
              <input type="text" name="password" placeholder="Initial password" minlength="8" required />
              <button class="btn btn-primary" type="submit">Create internal account</button>
              <p class="form-success small-note" hidden></p>
              <p class="form-error small-note" hidden></p>
            </form>
          </section>

          <section class="panel">
            <p class="eyebrow">Internal accounts</p>
            <h3>Manage members</h3>
            <div class="account-table">
              ${accounts.map((item) => `
                <div class="account-row">
                  <div>
                    <strong>${escapeHtml(item.full_name || item.email)}</strong>
                    <p>${escapeHtml(item.email)}</p>
                  </div>
                  <div class="account-actions">
                    ${item.role === 'admin' ? '<span class="tag">Admin</span>' : '<span class="tag tag-neutral">Member</span>'}
                    ${item.user_id !== me.user_id ? `<button class="btn btn-secondary btn-sm delete-account" data-user-id="${item.user_id}" data-email="${escapeHtml(item.email)}" type="button">Delete</button>` : ''}
                  </div>
                </div>
              `).join('')}
            </div>
          </section>

          <section class="panel">
            <p class="eyebrow">Send updates</p>
            <h3>Send text, image, or file to members</h3>
            <form id="send-message-form" class="stack-form compact-form" enctype="multipart/form-data">
              <input type="text" name="title" placeholder="Title" required />
              <textarea name="body" rows="5" placeholder="Message"></textarea>
              <div class="recipient-box">
                <label class="checkline"><input type="checkbox" name="broadcast" value="yes" /> Broadcast to all internal members</label>
                <div class="recipient-grid">
                  ${accounts.filter((item) => item.role === 'internal').map((item) => `<label class="checkline"><input type="checkbox" name="recipients" value="${item.user_id}" /> ${escapeHtml(item.full_name || item.email)}</label>`).join('') || '<p class="small-note">Create members first to choose recipients.</p>'}
                </div>
              </div>
              <input type="file" name="attachment" />
              <button class="btn btn-primary" type="submit">Send to selected members</button>
              <p class="form-success small-note" hidden></p>
              <p class="form-error small-note" hidden></p>
            </form>
          </section>` : ''}
        </div>
      </div>
    `;

    $$('.logout-btn', root).forEach((btn) => btn.addEventListener('click', signOutAndRedirect));

    const passwordForm = $('#change-password-form', root);
    passwordForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormState(passwordForm);
      try {
        const { error } = await supabase.auth.updateUser({ password: passwordForm.newPassword.value });
        if (error) throw error;
        passwordForm.reset();
        setText($('.form-success', passwordForm), 'Password updated successfully.', false);
      } catch (error) {
        setText($('.form-error', passwordForm), error.message || 'Could not update password.', false);
      }
    });

    const createForm = $('#create-internal-account', root);
    createForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormState(createForm);
      const button = $('button[type="submit"]', createForm);
      const original = button?.textContent || 'Create internal account';
      if (button) {
        button.disabled = true;
        button.textContent = 'Creating...';
      }
      try {
        const response = await supabase.functions.invoke('create-internal-user', {
          body: {
            full_name: createForm.name.value.trim(),
            email: createForm.email.value.trim().toLowerCase(),
            password: createForm.password.value,
          },
        });
        if (response.error) throw response.error;
        createForm.reset();
        setText($('.form-success', createForm), 'Internal account created.', false);
        await renderInternalPortal();
      } catch (error) {
        setText($('.form-error', createForm), error.message || 'Could not create account.', false);
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = original;
        }
      }
    });

    $$('.delete-account', root).forEach((btn) => btn.addEventListener('click', async () => {
      const email = btn.dataset.email || 'this account';
      if (!window.confirm(`Delete ${email}? This cannot be undone.`)) return;
      try {
        const response = await supabase.functions.invoke('delete-internal-user', {
          body: { user_id: btn.dataset.userId },
        });
        if (response.error) throw response.error;
        await renderInternalPortal();
      } catch (error) {
        alert(error.message || 'Could not delete account.');
      }
    }));

    const sendForm = $('#send-message-form', root);
    sendForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormState(sendForm);
      const button = $('button[type="submit"]', sendForm);
      const original = button?.textContent || 'Send to selected members';
      if (button) {
        button.disabled = true;
        button.textContent = 'Sending...';
      }
      try {
        const broadcast = $('input[name="broadcast"]', sendForm).checked;
        const recipientIds = $$('input[name="recipients"]:checked', sendForm).map((input) => input.value);
        if (!broadcast && recipientIds.length === 0) {
          throw new Error('Choose at least one recipient or enable broadcast.');
        }
        const messageId = crypto.randomUUID();
        const file = $('input[name="attachment"]', sendForm).files?.[0] || null;
        let attachmentPath = null;
        if (file) {
          attachmentPath = await uploadInternalAttachment(file, messageId);
        }
        const { error: insertError } = await supabase.from('internal_messages').insert({
          id: messageId,
          title: sendForm.title.value.trim(),
          body: sendForm.body.value.trim(),
          from_user_id: me.user_id,
          from_email: me.email,
          broadcast,
          attachment_path: attachmentPath,
          attachment_name: file?.name || null,
          attachment_type: file?.type || null,
        });
        if (insertError) throw insertError;

        if (!broadcast && recipientIds.length) {
          const recipientRows = recipientIds.map((userId) => ({ message_id: messageId, user_id: userId }));
          const { error: recipientsError } = await supabase.from('internal_message_recipients').insert(recipientRows);
          if (recipientsError) throw recipientsError;
        }
        sendForm.reset();
        setText($('.form-success', sendForm), 'Message sent to selected members.', false);
        await renderInternalPortal();
      } catch (error) {
        setText($('.form-error', sendForm), error.message || 'Could not send message.', false);
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = original;
        }
      }
    });
  }

  async function setupMembershipAuth() {
    const page = $('#membership-auth');
    if (!page) return;
    const supabase = getSupabase();
    if (!supabase) {
      const panel = page.closest('.container') || page;
      const message = document.createElement('p');
      message.className = 'small-note';
      message.textContent = 'Supabase is not configured yet. Open site/config.js and fill in your project details first.';
      panel.prepend(message);
      return;
    }

    const checkoutForm = $('#membership-checkout-form');
    const activateForm = $('#membership-set-password-form');
    const loginForm = $('#membership-login-form');
    const checkoutSuccess = $('#membership-checkout-success');
    const checkoutError = $('#membership-checkout-error');
    const activationHint = $('#membership-activation-hint');

    const params = new URLSearchParams(window.location.search);
    if (params.get(MEMBERSHIP_SUCCESS_PARAM) === 'success' && checkoutSuccess) {
      checkoutSuccess.hidden = false;
      checkoutSuccess.textContent = 'Payment received. Your membership account is being created now. Please check your email for the activation link, then come back here to set your password.';
    }
    if (params.get(MEMBERSHIP_SUCCESS_PARAM) === 'cancel' && checkoutError) {
      checkoutError.hidden = false;
      checkoutError.textContent = 'Payment was cancelled. You can choose a plan and try again.';
    }

    checkoutForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormState(checkoutForm);
      const button = $('button[type="submit"]', checkoutForm);
      const original = button?.textContent || 'Continue to payment';
      if (button) {
        button.disabled = true;
        button.textContent = 'Preparing payment...';
      }
      try {
        const email = checkoutForm.email.value.trim().toLowerCase();
        const tier = checkoutForm.tier.value;
        const response = await supabase.functions.invoke('create-checkout-session', {
          body: {
            email,
            plan_slug: tier,
            return_url: `${window.location.origin}/membership/`,
          },
        });
        if (response.error) throw response.error;
        const checkoutUrl = response.data?.url;
        if (!checkoutUrl) throw new Error('Checkout URL was not returned.');
        window.location.href = checkoutUrl;
      } catch (error) {
        setText($('.form-error', checkoutForm), error.message || 'Could not start payment.', false);
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = original;
        }
      }
    });

    const session = await getSession();
    let invitedMember = null;
    try {
      invitedMember = session?.user ? await fetchMyProfile() : null;
    } catch {
      invitedMember = null;
    }

    if (activationHint) {
      if (session?.user && invitedMember?.role === 'member') {
        activationHint.hidden = false;
        activationHint.textContent = `Signed in as ${invitedMember.email}. Set your password to finish activating this membership account.`;
      } else {
        activationHint.hidden = false;
        activationHint.textContent = 'After payment, open the activation email we send you, then set your password here.';
      }
    }

    activateForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormState(activateForm);
      const button = $('button[type="submit"]', activateForm);
      const original = button?.textContent || 'Set password and enter portal';
      if (button) {
        button.disabled = true;
        button.textContent = 'Saving...';
      }
      try {
        const user = await getCurrentUser();
        if (!user) throw new Error('Please open the activation email first, then return to this page to set your password.');
        const profile = await fetchMyProfile();
        if (!profile || profile.role !== 'member') {
          throw new Error('This activation link is not connected to a membership account.');
        }
        const { error } = await supabase.auth.updateUser({ password: activateForm.newPassword.value });
        if (error) throw error;
        activateForm.reset();
        setText($('.form-success', activateForm), 'Password set successfully. Redirecting to your membership portal...', false);
        window.location.href = '/portal/membership/';
      } catch (error) {
        setText($('.form-error', activateForm), error.message || 'Could not set password.', false);
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = original;
        }
      }
    });

    loginForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormState(loginForm);
      const button = $('button[type="submit"]', loginForm);
      const original = button?.textContent || 'Sign in';
      if (button) {
        button.disabled = true;
        button.textContent = 'Signing in...';
      }
      try {
        const email = loginForm.email.value.trim().toLowerCase();
        const password = loginForm.password.value;
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const profile = await fetchMyProfile();
        if (!profile || profile.role !== 'member' || profile.membership_status !== 'active') {
          await supabase.auth.signOut();
          throw new Error('Membership is not active yet. Please complete payment and activate your account first.');
        }
        window.location.href = '/portal/membership/';
      } catch (error) {
        showError(loginForm, error.message || 'Incorrect email or password.');
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = original;
        }
      }
    });
  }

  async function handleMembershipCheckoutReturn() {
    return null;
  }

  async function renderMembershipPortal() {
    const root = $('#membership-portal');
    if (!root) return;
    const supabase = getSupabase();
    if (!supabase) {
      requireSupabaseMessage(root, 'Open site/config.js, fill in your Supabase URL and anon key, then refresh the page.');
      return;
    }
    const user = await getCurrentUser();
    if (!user) {
      window.location.href = '/membership/';
      return;
    }

    let member;
    try {
      member = await fetchMyProfile();
    } catch (error) {
      requireSupabaseMessage(root, error.message || 'Could not load profile.');
      return;
    }

    if (!member || member.role !== 'member' || member.membership_status !== 'active') {
      window.location.href = '/membership/';
      return;
    }

    bindSessionWatch();

    const { data: latestOrder } = await supabase
      .from('membership_orders')
      .select('plan_name, amount_cents, currency, paid_at')
      .eq('user_id', member.user_id)
      .eq('payment_status', 'paid')
      .order('paid_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const benefits = [
      'Regular PUCO magazine and member updates',
      'Priority access to selected souvenirs and commemorative items',
      'Discounted pricing in the PUCO shop',
    ];

    root.innerHTML = `
      <div class="dashboard-shell">
        <aside class="dashboard-sidebar panel">
          <span class="tag">${escapeHtml(member.membership_tier || 'Membership')}</span>
          <h2>Membership Portal</h2>
          <p>${escapeHtml(member.email)}</p>
          <p class="small-note">Paid through ${fmt(member.paid_through)}</p>
          <button class="btn btn-secondary logout-btn" type="button">Logout</button>
        </aside>
        <div class="dashboard-main">
          <section class="panel">
            <p class="eyebrow">Benefits</p>
            <h3>Your current membership</h3>
            <div class="cards-3 compact-grid">
              ${benefits.map((perk) => `<article class="detail-card"><h4>${escapeHtml(perk)}</h4><p>Included with your active ${escapeHtml(member.membership_tier || 'PUCO')} membership.</p></article>`).join('')}
            </div>
          </section>
          <section class="panel">
            <p class="eyebrow">Billing</p>
            <h3>Latest paid membership</h3>
            <ul class="detail-list">
              <li><i class="fa-solid fa-receipt"></i><span>Plan: ${escapeHtml(latestOrder?.plan_name || member.membership_tier || 'Membership')}</span></li>
              <li><i class="fa-solid fa-wallet"></i><span>Amount: ${latestOrder ? `${(latestOrder.amount_cents / 100).toFixed(2)} ${escapeHtml((latestOrder.currency || 'CNY').toUpperCase())}` : '—'}</span></li>
              <li><i class="fa-solid fa-calendar-check"></i><span>Paid at: ${fmt(latestOrder?.paid_at)}</span></li>
            </ul>
          </section>
          <section class="panel">
            <p class="eyebrow">Security</p>
            <h3>Change your password</h3>
            <form id="membership-password-form" class="stack-form compact-form">
              <input type="password" name="newPassword" placeholder="New password" minlength="8" required />
              <button class="btn btn-primary" type="submit">Update password</button>
              <p class="form-success small-note" hidden></p>
              <p class="form-error small-note" hidden></p>
            </form>
          </section>
        </div>
      </div>
    `;

    $$('.logout-btn', root).forEach((btn) => btn.addEventListener('click', signOutAndRedirect));

    const form = $('#membership-password-form', root);
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormState(form);
      try {
        const { error } = await supabase.auth.updateUser({ password: form.newPassword.value });
        if (error) throw error;
        form.reset();
        setText($('.form-success', form), 'Password updated successfully.', false);
      } catch (error) {
        setText($('.form-error', form), error.message || 'Could not update password.', false);
      }
    });
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function hydrateAuthNav() {
    const supabase = getSupabase();
    if (!supabase) return;
    const session = await getSession();
    const links = $$('.login-link');
    if (!session) {
      links.forEach((link) => {
        link.textContent = 'Login';
        link.href = '/login/';
      });
      return;
    }
    let profile = null;
    try {
      profile = await fetchMyProfile();
    } catch {
      profile = null;
    }
    const target = profile?.role === 'member' ? '/portal/membership/' : profile?.role ? '/portal/internal/' : '/login/';
    links.forEach((link) => {
      link.textContent = 'Portal';
      link.href = target;
    });
  }

  async function bootSupabaseAwarePages() {
    await hydrateAuthNav();
    await setupInternalLogin();
    await setupMembershipAuth();
    await renderInternalPortal();
    await renderMembershipPortal();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    setupMenu();
    setupContactForm();
    await bootSupabaseAwarePages();
  });
})();
