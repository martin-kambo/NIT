// community.js — Phase 4B.25A extraction
// Community-specific JavaScript: Notice Board, Ad Requests, Ask AI.
// Extracted from public/index.html (Phase 4B.25A).
// Depends on globals in index.html: apiCall, currentUser, showToast,
// addNotification, renderNotifBell, initScrollReveal, window.currentPeriodEnd

// ─────────────────────────────────────────────────────────────
// NOTICE BOARD
// ─────────────────────────────────────────────────────────────
// ══ NOTICEBOARD — Live API-driven ══
let activeNoticeFilter = "all";
let _noticeCache = [];

const NOTICE_EMOJI = {
  business: "🛒", event: "🎉", public: "📢", jobs: "💼", general: "📌", service: "🛠️", payment: "💳"
};

// ── Presentation taxonomy (Phase 4B.31D) ─────────────────────────────────
// DISPLAY ONLY. notices.category values in the database are unchanged
// (public | event | business | jobs | general, plus the free-text values
// 'service' and 'payment' that the column has always accepted). "Alerts" is
// not a category: it is the existing priority = 'high' flag.
// One record, several surfaces: the Notice Board tab and My Ward → Recent
// Notices both read /api/notices and label notices through these helpers.
const NOTICE_CATS = {
  public:   { label: "Official Notice",  cls: "ncat-public"  },
  service:  { label: "Service Update",   cls: "ncat-service" },
  payment:  { label: "Payment Reminder", cls: "ncat-payment" },
  event:    { label: "Community Event",  cls: "ncat-event"   },
  business: { label: "Business",         cls: "ncat-business"},
  jobs:     { label: "Jobs",             cls: "ncat-jobs"    },
  general:  { label: "General",          cls: ""             }
};
// Short, honest notes shown under the chips for the two categories people may
// misread. These are public ward notices — no personal accounts or balances.
const NOTICE_FILTER_NOTES = {
  service: "Public service information from your ward office. Applications and personal records are not handled here.",
  payment: "Public payment reminders from your ward office. Personal balances and receipts are not shown here."
};
// Paid ads share the feed but are never presented as official: an ad filed under
// "public" keeps the neutral "Public Notice" label, and ads never match the
// official-only filters (Official Notices, Alerts, Service Updates, Payment Reminders).
const NOTICE_OFFICIAL_ONLY = ["public", "service", "payment"];
function noticeCategoryInfo(n) {
  const c = (n && n.category) || "general";
  if (n && n.is_ad && c === "public") return { label: "Public Notice", cls: "ncat-public" };
  return NOTICE_CATS[c] || { label: c, cls: "" };
}
function noticeIsAlert(n) { return !!n && n.priority === "high" && !n.is_ad; }
function noticeMatchesFilter(n, key) {
  if (!key || key === "all") return true;
  if (key === "alerts") return noticeIsAlert(n);
  if (n.is_ad && NOTICE_OFFICIAL_ONLY.includes(key)) return false;
  return n.category === key;
}
function syncNoticeFilterNote() {
  const el = document.getElementById("noticeFilterNote");
  if (!el) return;
  const t = NOTICE_FILTER_NOTES[activeNoticeFilter] || "";
  el.textContent = t;
  el.classList.toggle("hidden", !t);
}

// ── Safe output helpers (Phase 4B.32) ────────────────────────────────────
// Notice and advertisement fields are untrusted (an advertiser is any logged-in
// user, and an admin approving an ad does not make its text safe). Notice cards
// are therefore built with DOM APIs (textContent / addEventListener); no notice
// value is ever concatenated into HTML, an attribute or an inline handler.
// escHtml() exists only for the few places that must hand a string to an API that
// itself parses HTML (showToast, and the ad-history template below).
function escHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// tel: link from a free-text contact number: optional leading +, then digits only
// (7-15 of them). Anything else -> "" and the card shows the More button instead.
// Never a javascript:/data: URL, never a quote or angle bracket in the attribute.
function safeTelHref(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!/^\+?[0-9\s().-]{7,20}$/.test(s)) return "";
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return "tel:" + (s.charAt(0) === "+" ? "+" : "") + digits;
}
function noticeEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

async function renderNoticeboardTab() {
  // Wire filter buttons
  document.querySelectorAll(".notice-filter").forEach(btn => {
    btn.onclick = () => {
      activeNoticeFilter = btn.dataset.nf;
      document.querySelectorAll(".notice-filter").forEach(b =>
        b.classList.toggle("active", b.dataset.nf === activeNoticeFilter));
      syncNoticeFilterNote();
      buildNotices(_noticeCache);
    };
  });

  const grid = document.getElementById("noticesGrid");
  if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2rem;color:var(--mid-gray)"><i class="fas fa-spinner fa-spin"></i>&nbsp; Loading notices...</div>';

  try {
    const res = await fetch('/api/notices');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.success) {
      _noticeCache = data.notices;
      buildNotices(_noticeCache);
    } else {
      throw new Error(data.error || 'Unknown error');
    }
  } catch (err) {
    console.error('Noticeboard fetch error:', err);
    if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2rem;color:var(--mid-gray)">⚠️ Could not load notices. Please refresh.</div>';
  }
}

// One notice/ad card. Same structure, classes and inline styles as before; every
// notice-controlled value goes in through textContent or a validated property.
function buildNoticeCard(n) {
  const cm       = noticeCategoryInfo(n);
  const emoji    = NOTICE_EMOJI[n.category] || "📌";
  const isUrgent = noticeIsAlert(n);
  const isAd     = !!n.is_ad;

  // Smart relative date
  let dateStr = "";
  if (n.created_at) {
    const ts   = new Date(n.created_at).getTime();
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    const hrs  = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (diff < 60000)      dateStr = "Just now";
    else if (mins < 60)    dateStr = `${mins}m ago`;
    else if (hrs < 24)     dateStr = `${hrs}h ago`;
    else if (days === 1)   dateStr = "Yesterday";
    else if (days < 7)     dateStr = `${days}d ago`;
    else                   dateStr = new Date(n.created_at).toLocaleDateString("en-KE", { day:"numeric", month:"short" });
  }

  const author = n.author || (isAd ? "Sponsored" : "Admin");
  const title  = n.title == null ? "" : String(n.title);

  const card = noticeEl("div", "notice-card scroll-reveal" + (isAd ? " notice-card--ad" : ""));

  const top = noticeEl("div", "notice-card-top");
  const em  = noticeEl("span", "", emoji);
  em.style.cssText = "font-size:0.85rem;line-height:1;margin-right:0.1rem";
  top.appendChild(em);
  top.appendChild(noticeEl("span", "notice-cat-badge " + cm.cls, cm.label));
  if (isAd) top.appendChild(noticeEl("span", "notice-sponsored", "Ad"));
  if (isUrgent && !isAd) {
    const urgent = noticeEl("span", "notice-sponsored", "⚠ Urgent");
    urgent.style.cssText = "background:#e63946;color:#fff;border:none";
    top.appendChild(urgent);
  }
  card.appendChild(top);

  const body = noticeEl("div", "notice-card-body");
  body.appendChild(noticeEl("div", "notice-card-title", title));
  body.appendChild(noticeEl("div", "notice-card-desc", n.content == null ? "" : String(n.content)));
  card.appendChild(body);

  const footer = noticeEl("div", "notice-card-footer");
  const meta   = noticeEl("div", "notice-meta");
  meta.appendChild(noticeEl("strong", "", String(author)));
  meta.appendChild(document.createTextNode(" · " + dateStr));
  footer.appendChild(meta);

  // Ads with a usable phone number get a Call link; everything else gets More.
  // More shows the notice title in a toast, exactly as before. showToast() renders
  // HTML, so the title is escaped for that sink; the handler is attached with
  // addEventListener and closes over this card's own notice (no inline JS).
  const tel = isAd ? safeTelHref(n.contact_phone) : "";
  let cta;
  if (tel) {
    cta = noticeEl("a", "notice-cta-btn", "📞 Call");
    cta.href = tel;
    cta.style.textDecoration = "none";
  } else {
    cta = noticeEl("button", "notice-cta-btn", "More →");
    cta.type = "button";
    cta.addEventListener("click", () => showToast("📌 " + escHtml(title), "info"));
  }
  footer.appendChild(cta);
  card.appendChild(footer);
  return card;
}

function buildNotices(notices) {
  const grid  = document.getElementById("noticesGrid");
  const empty = document.getElementById("noticeEmpty");
  if (!grid) return;

  const filtered = notices.filter(n => noticeMatchesFilter(n, activeNoticeFilter));

  if (!filtered.length) {
    grid.innerHTML = "";
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");

  const frag = document.createDocumentFragment();
  filtered.forEach(n => frag.appendChild(buildNoticeCard(n)));
  grid.textContent = "";
  grid.appendChild(frag);
  initScrollReveal(); // newly injected cards need the observer re-run on them
}


// ─────────────────────────────────────────────────────────────
// AD REQUESTS
// ─────────────────────────────────────────────────────────────
const AD_CHAT_KEY="ngoliba_ad_chat";
function getAdChat(){return JSON.parse(localStorage.getItem(AD_CHAT_KEY)||"[]");}
function saveAdChat(arr){localStorage.setItem(AD_CHAT_KEY,JSON.stringify(arr));}

function initAdRequestChat(){
  const openBtn=document.getElementById("openAdRequestBtn");
  const closeBtn=document.getElementById("closeAdRequestBtn");
  const panel=document.getElementById("adRequestPanel");
  if(!openBtn)return;
  openBtn.onclick=()=>{
    panel.classList.toggle("hidden");
    if(!panel.classList.contains("hidden")) {
      // Auto-switch to history if user has prior requests, otherwise stay on new
      switchAdPanel('new');
    }
  };
  closeBtn.onclick=()=>panel.classList.add("hidden");
}

// ── Panel tab switching ──
function switchAdPanel(tab) {
  const newPane     = document.getElementById('adFormState');
  const successPane = document.getElementById('adSuccessState');
  const payPane     = document.getElementById('adPayState');
  const histPane    = document.getElementById('adHistoryPane');
  const tabNew      = document.getElementById('adPanelTabNew');
  const tabHist     = document.getElementById('adPanelTabHistory');

  if (tab === 'history') {
    if (newPane)     newPane.style.display     = 'none';
    if (successPane) successPane.style.display = 'none';
    if (payPane)     payPane.style.display     = 'none';
    if (histPane)    histPane.style.display    = 'block';
    if (tabNew)  { tabNew.style.borderBottomColor  = 'transparent'; tabNew.style.color  = 'var(--mid-gray)'; }
    if (tabHist) { tabHist.style.borderBottomColor = 'var(--forest)'; tabHist.style.color = 'var(--forest)'; }
    loadMyAdRequests();
  } else {
    if (histPane) histPane.style.display = 'none';
    // Restore whichever new-request state was active
    const hasSuccess = lastAdRequestId && successPane?.innerHTML.trim();
    if (newPane && !lastAdRequestId)  newPane.style.display = 'block';
    if (successPane && lastAdRequestId) successPane.style.display = 'block';
    if (tabNew)  { tabNew.style.borderBottomColor  = 'var(--forest)'; tabNew.style.color  = 'var(--forest)'; }
    if (tabHist) { tabHist.style.borderBottomColor = 'transparent'; tabHist.style.color = 'var(--mid-gray)'; }
  }
}

// ── Load & render history ──
async function loadMyAdRequests() {
  const list = document.getElementById('adHistoryList');
  if (!list) return;
  list.innerHTML = '<div style="text-align:center;padding:2rem 0;color:var(--mid-gray);font-size:0.82rem;">⏳ Loading…</div>';
  try {
    const res  = await fetch('/api/my-ad-requests');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderAdHistory(data.adRequests, list);
  } catch (err) {
    list.innerHTML = `<div style="text-align:center;padding:1.5rem 0;color:var(--red-accent);font-size:0.8rem;">⚠️ ${escHtml(err.message)}</div>`;
  }
}

function renderAdHistory(requests, container) {
  if (!requests.length) {
    container.innerHTML = '<div style="text-align:center;padding:2rem 0;color:var(--mid-gray);font-size:0.82rem;">You have no ad requests yet.</div>';
    return;
  }

  const statusConfig = {
    pending:         { label: '⏳ Under Review',      bg: '#fff7ed', color: '#b45309' },
    payment_pending: { label: '💳 Payment Required',  bg: '#f5f3ff', color: '#7c3aed' },
    approved:        { label: '✅ Approved & Live',    bg: '#f0fdf4', color: '#15803d' },
    rejected:        { label: '❌ Not Approved',       bg: '#fef2f2', color: '#b91c1c' },
    completed:       { label: '🏁 Completed',          bg: '#eff6ff', color: '#1d4ed8' },
  };

  // Every request field below is advertiser- or admin-supplied text: escHtml() for text, and the
  // Pay button gets its data from the request object via addEventListener (no inline handler).
  container.innerHTML = requests.map((r, i) => {
    const s   = Object.prototype.hasOwnProperty.call(statusConfig, r.status) ? statusConfig[r.status] : { label: r.status, bg: '#f3f4f6', color: '#6b7280' };
    const dt  = new Date(r.submitted_at).toLocaleDateString('en-KE', { day:'numeric', month:'short', year:'numeric' });
    const isPayable = r.status === 'payment_pending';

    return `
    <div style="border:1px solid var(--sand);border-radius:0.75rem;padding:0.9rem;margin-bottom:0.75rem;background:white;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem;margin-bottom:0.5rem;">
        <div style="font-weight:700;font-size:0.85rem;color:var(--text-dark);flex:1;">${escHtml(r.business_name)}</div>
        <span style="font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:50px;white-space:nowrap;background:${s.bg};color:${s.color};">${escHtml(s.label)}</span>
      </div>
      <div style="font-size:0.78rem;color:var(--mid-gray);margin-bottom:0.5rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escHtml(r.ad_content)}</div>
      <div style="display:flex;gap:1rem;font-size:0.72rem;color:var(--mid-gray);flex-wrap:wrap;margin-bottom:${isPayable || r.notes ? '0.65rem' : '0'};">
        <span>⏱ ${escHtml(r.duration)}</span>
        <span>📅 ${dt}</span>
        ${r.fee ? `<span style="color:#7c3aed;font-weight:700;">KES ${(Number(r.fee) || 0).toLocaleString()}</span>` : ''}
      </div>
      ${r.notes ? `<div style="font-size:0.74rem;color:var(--text-mid);background:var(--cream-dark);border-radius:0.4rem;padding:0.4rem 0.6rem;margin-bottom:${isPayable ? '0.65rem' : '0'};">📝 ${escHtml(r.notes)}</div>` : ''}
      ${isPayable ? `
        <button type="button" data-ad-pay="${i}"
          style="width:100%;display:flex;align-items:center;justify-content:center;gap:0.4rem;background:linear-gradient(135deg,#00a550,#007a3a);color:white;border:none;border-radius:50px;padding:0.5rem;font-size:0.8rem;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;">
          📲 Pay KES ${(Number(r.fee) || 0).toLocaleString()} via M-Pesa
        </button>` : ''}
    </div>`;
  }).join('');
  container.querySelectorAll('[data-ad-pay]').forEach(btn => btn.addEventListener('click', () => {
    const r = requests[Number(btn.dataset.adPay)];
    if (r) openPayFromHistory(r.id, Number(r.fee) || 0, r.duration);
  }));
}

// Opens the pay pane from history tab (switching to new-request pane area)
function openPayFromHistory(id, fee, duration) {
  lastAdRequestId = id;
  // Switch to the "new" tab area to show the pay pane
  switchAdPanel('new');
  document.getElementById('adFormState').style.display     = 'none';
  document.getElementById('adSuccessState').style.display  = 'none';
  document.getElementById('adPayState').style.display      = 'block';
  document.getElementById('adPayAmount').textContent        = `KES ${fee.toLocaleString()}`;
  document.getElementById('adPayDuration').textContent      = `Duration: ${duration}`;
  document.getElementById('adAdminNotes').style.display     = 'none';
  if (currentUser?.phone) {
    const n = currentUser.phone.replace(/^0/, '').replace(/^254/, '').slice(0, 9);
    document.getElementById('adPayPhone').value = n;
  }
}

async function submitAdRequest(){
  const businessName = document.getElementById("arBusinessName").value.trim();
  const adContent    = document.getElementById("arAdContent").value.trim();
  const category     = document.getElementById("arCategory").value;
  const duration     = document.getElementById("arDuration").value;
  const contactPhone = document.getElementById("arContactPhone").value.trim();
  const contactEmail = document.getElementById("arContactEmail").value.trim();
  const errEl        = document.getElementById("arError");
  const btn          = document.getElementById("adRequestSendBtn");

  // Validate
  if (!businessName) { showArError("Please enter your business or organisation name."); return; }
  if (!adContent)    { showArError("Please describe what you'd like to advertise."); return; }
  if (!contactPhone) { showArError("Please enter a contact phone number."); return; }
  errEl.style.display = "none";

  // Loading state
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…';

  try {
    const res = await fetch('/api/ad-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessName, adContent, category, duration, contactPhone, contactEmail: contactEmail || undefined })
    });
    const data = await res.json();
    if (res.status === 401) {
      showArError('You must be logged in to submit an ad request. Please log in and try again.');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Request';
      return;
    }
    if (!data.success) throw new Error(data.error || 'Submission failed');

    // Remember ID so user can check status / pay later
    lastAdRequestId = data.id;

    // Show success state
    document.getElementById("adFormState").style.display    = "none";
    document.getElementById("adSuccessState").style.display = "block";
    addNotification({icon:"📣",iconCls:"ni-notice",text:"Your <strong>ad request</strong> was submitted. Admin will respond within 24 hours.",type:"notice"});

  } catch(err) {
    showArError("Failed to submit: " + err.message);
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Request';
  }
}

function showArError(msg){
  const el = document.getElementById("arError");
  el.textContent = msg;
  el.style.display = "block";
}

// Tracks the last submitted request ID so the user can check status
let lastAdRequestId = null;

async function checkAdRequestStatus() {
  if (!lastAdRequestId) return;
  try {
    const res  = await fetch(`/api/ad-requests/${lastAdRequestId}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    const r = data.adRequest;

    if (r.status === 'payment_pending') {
      // Switch to pay state
      document.getElementById('adSuccessState').style.display = 'none';
      document.getElementById('adPayState').style.display    = 'block';
      document.getElementById('adPayAmount').textContent     = `KES ${r.fee.toLocaleString()}`;
      document.getElementById('adPayDuration').textContent   = `Duration: ${r.duration}`;

      const notesEl = document.getElementById('adAdminNotes');
      if (r.notes) { notesEl.textContent = `📝 Admin note: ${r.notes}`; notesEl.style.display = 'block'; }

      // Pre-fill phone from profile if available
      if (currentUser?.phone) {
        const n = currentUser.phone.replace(/^0/, '').replace(/^254/, '').slice(0, 9);
        document.getElementById('adPayPhone').value = n;
      }
    } else if (r.status === 'approved') {
      showToast('🎉 Your ad has been approved and is now live!', 'success');
    } else if (r.status === 'rejected') {
      showToast('Your ad request was not approved. Please contact admin.', 'error');
    } else {
      showToast('⏳ Still under review — check back soon.', 'info');
    }
  } catch (err) {
    showToast('Could not check status: ' + err.message, 'error');
  }
}

async function initiateAdPayment() {
  const raw = document.getElementById('adPayPhone').value.trim();
  if (!/^\d{9}$/.test(raw)) {
    const el = document.getElementById('adPayError');
    el.textContent = 'Enter a valid 9-digit M-Pesa number e.g. 712 345 678';
    el.style.display = 'block';
    return;
  }
  document.getElementById('adPayError').style.display = 'none';

  const btn = document.getElementById('adPayBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="btn-spinner" style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.4);border-top-color:white;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block;"></div> Sending STK Push…';

  const fullPhone = '254' + raw;
  try {
    // Reuse the existing DARAJA engine (simulated / real in production)
    await DARAJA.getAccessToken();
    const stk = await DARAJA.initiateStkPush({ phone: fullPhone, amount: parseInt(document.getElementById('adPayAmount').textContent.replace(/[^\d]/g, '')), accountRef: 'NGOLIBA-AD' });
    if (stk.ResponseCode !== '0') throw new Error(stk.ResponseDescription);

    // Simulate PIN confirmation (same pattern as voting flow)
    btn.innerHTML = '⏳ Waiting for M-Pesa PIN…';
    const result = await DARAJA.simulateIpnCallback(stk.CheckoutRequestID, true);

    if (result.ResultCode === 0) {
      // Confirm payment on the server
      const confirm = await fetch(`/api/ad-requests/${lastAdRequestId}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mpesaReceiptNumber: result.MpesaReceiptNumber, phone: fullPhone })
      });
      const confirmData = await confirm.json();
      if (!confirmData.success) throw new Error(confirmData.error);

      // Success UI
      document.getElementById('adPayState').style.display = 'none';
      document.getElementById('adSuccessState').style.display = 'block';
      document.getElementById('adSuccessState').innerHTML = `
        <div style="font-size:2.5rem;margin-bottom:0.75rem;">🎉</div>
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:1rem;color:var(--text-dark);margin-bottom:0.4rem;">Ad Submitted <span style="font-size:0.7rem;font-weight:500;color:var(--mid-gray);">(Preview)</span></div>
        <div style="font-size:0.82rem;color:var(--mid-gray);line-height:1.5;margin-bottom:0.75rem;">
          Simulated receipt: <strong>${result.MpesaReceiptNumber}</strong><br>Your ad is now <strong>live</strong>. <em>No real M-Pesa charge occurred.</em>
        </div>
        <button onclick="resetAdForm()" style="display:inline-flex;align-items:center;gap:0.4rem;background:var(--cream-dark);border:1px solid var(--sand);border-radius:50px;padding:0.45rem 1.2rem;font-size:0.78rem;font-weight:600;cursor:pointer;font-family:'Outfit',sans-serif;color:var(--text-mid);">
          Done
        </button>`;
      addNotification({ icon:'💳', iconCls:'ni-notice', text:`M-Pesa payment confirmed — your ad is now <strong>live</strong>! Receipt: ${result.MpesaReceiptNumber}`, type:'notice' });
      // Refresh history so the status updates
      loadMyAdRequests();
    } else {
      throw new Error(result.ResultDesc || 'Payment was not confirmed');
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<span style="font-size:1rem;">📲</span> Pay via M-Pesa';
    const el = document.getElementById('adPayError');
    el.textContent = 'Payment failed: ' + err.message;
    el.style.display = 'block';
  }
}

function resetAdForm(){
  ["arBusinessName","arContactPhone","arContactEmail"].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value="";
  });
  const ta=document.getElementById("arAdContent"); if(ta) ta.value="";
  document.getElementById("adFormState").style.display    = "block";
  document.getElementById("adSuccessState").style.display = "none";
  document.getElementById("adPayState").style.display     = "none";
  document.getElementById("arError").style.display        = "none";
  const btn=document.getElementById("adRequestSendBtn");
  if(btn){ btn.disabled=false; btn.innerHTML='<i class="fas fa-paper-plane"></i> Submit Request'; }
  lastAdRequestId = null;
}

// ─────────────────────────────────────────────────────────────
// ASK AI
// ─────────────────────────────────────────────────────────────
async function handleAIAsk(){
  const input=document.getElementById("aiPromptInput").value.trim();
  if(!input){showToast("Enter a question first","error");return;}
  const responseEl=document.getElementById("aiResponse");
  responseEl.style.display="block";
  responseEl.innerHTML='<div class="ai-typing"><span></span><span></span><span></span></div>';
  document.getElementById("aiAskBtn").disabled=true;

  // Call the real Anthropic API
  try{
    const agg=getCurrentPeriodAggregated();
    const votesSummary=CANDIDATES.map(c=>`${c.name} (${c.party}): ${agg[c.id]?.total||0} votes`).join(", ");
    const users=DB.getUsers();
    const wardLabel  = (typeof currentUser!=='undefined'&&currentUser?.wardName)  || 'this ward';
    const countyLabel= (typeof currentUser!=='undefined'&&currentUser?.countyName) || 'Kenya';
    const subLabel   = SUBLOCATIONS.length>0 ? SUBLOCATIONS.join(', ') : 'various sublocations';
    const context=`You are the AI analyst for eTaifa Link, a ward-level opinion poll platform in ${wardLabel}, ${countyLabel}. The poll tracks ${CANDIDATES.length} MCA candidates. Current cycle vote totals: ${votesSummary}. Total registered voters: ${users.length}. Sublocations: ${subLabel}. Answer the user's question concisely and insightfully in 2-4 sentences. Be specific to ${wardLabel} context.`;
    const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:300,system:context,messages:[{role:"user",content:input}]})});
    const data=await res.json();
    const reply=data.content?.[0]?.text||"I could not generate a response. Please try again.";
    responseEl.innerHTML=reply;
  }catch(e){
    // Fallback to local AI
    responseEl.innerHTML=generateLocalAIResponse(input);
  }
  document.getElementById("aiAskBtn").disabled=false;
}

function generateLocalAIResponse(query){
  // Phase 3B Polish: this fallback previously invented ward-specific
  // statistics, percentages, and candidate claims whenever the live AI
  // request failed. It no longer fabricates any data — it just tells the
  // user live analysis isn't available right now, regardless of what they
  // asked.
  return "Live AI analysis is currently unavailable. Please try again in a moment — in the meantime, the Leaderboard and Notice Board tabs have up-to-date information.";
}

function getTimeToReset(){
  if(!window.currentPeriodEnd) return "soon";
  const diff=new Date(window.currentPeriodEnd)-Date.now();
  if(diff<=0) return "now";
  const m=Math.floor(diff/60000), s=Math.floor((diff%60000)/1000);
  return `${m}m ${s}s`;
}
