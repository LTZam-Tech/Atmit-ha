// Demo app logic: bilingual (en/ar), login rules, protected inventory page.
const I18N = {
  en: {
    username: 'Username', password: 'Password', login: 'Login', forgot: 'Forgot password?',
    products: 'Products', logout: 'Logout', add: 'Add to cart', remove: 'Remove', cart: 'Cart', yourCart: 'Your cart', continue: 'Continue shopping', profile: 'My profile', saved: 'Profile saved', save: 'Save',
    errName: 'Full name is required', errEmail: 'Enter a valid email address', errAge: 'Age must be between 18 and 99', errCountry: 'Choose a country', errPhone: 'Enter a valid mobile number', errLong: 'Text is too long',
    errRequiredUser: 'Epic sadface: Username is required',
    errRequiredPass: 'Epic sadface: Password is required',
    errLocked: 'Epic sadface: Sorry, this user has been locked out.',
    errMismatch: 'Epic sadface: Username and password do not match any user in this service',
  },
  ar: {
    username: 'اسم المستخدم', password: 'كلمة المرور', login: 'دخول', forgot: 'نسيت كلمة المرور؟',
    products: 'المنتجات', logout: 'تسجيل الخروج', add: 'أضف إلى السلة', remove: 'إزالة', cart: 'السلة', yourCart: 'سلتك', continue: 'متابعة التسوق', profile: 'ملفي الشخصي', saved: 'تم حفظ الملف', save: 'حفظ',
    errName: 'الاسم الكامل مطلوب', errEmail: 'أدخل بريداً إلكترونياً صحيحاً', errAge: 'العمر يجب أن يكون بين 18 و 99', errCountry: 'اختر الدولة', errPhone: 'أدخل رقم جوال صحيح', errLong: 'النص طويل جداً',
    errRequiredUser: 'خطأ: اسم المستخدم مطلوب',
    errRequiredPass: 'خطأ: كلمة المرور مطلوبة',
    errLocked: 'خطأ: تم قفل هذا المستخدم.',
    errMismatch: 'خطأ: اسم المستخدم وكلمة المرور غير متطابقين',
  },
};
const USERS = { standard_user: 'ok', locked_out_user: 'locked', slow_user: 'slow' };
const PASSWORD = 'secret_sauce';

// Language: ?lang= override, otherwise the browser language (Playwright `locale`)
const lang = new URLSearchParams(location.search).get('lang') ?? (navigator.language.startsWith('ar') ? 'ar' : 'en');
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
const t = I18N[lang] ?? I18N.en;
document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t[el.dataset.i18n]));
document.querySelectorAll('[data-i18n-ph]').forEach((el) => (el.placeholder = t[el.dataset.i18nPh]));

const form = document.querySelector('#login-form');
if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = form.username.value.trim();
    const p = form.password.value;
    const err = document.querySelector('[data-test="error"]');
    const show = (msg) => { err.textContent = msg; err.hidden = false; };
    if (!u) return show(t.errRequiredUser);
    if (!p) return show(t.errRequiredPass);
    if (!(u in USERS) || p !== PASSWORD) return show(t.errMismatch);
    if (USERS[u] === 'locked') return show(t.errLocked);
    localStorage.setItem('user', u);
    setTimeout(() => (location.href = '/inventory.html'), USERS[u] === 'slow' ? 1500 : 0);
  });
}

if (document.body.dataset.page === 'profile') {
  if (!localStorage.getItem('user')) location.href = '/';
  const f = document.querySelector('#profile-form');
  const err = document.querySelector('[data-test="profile-error"]'), ok = document.querySelector('[data-test="profile-saved"]');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    ok.hidden = true;
    const v = (n) => f.elements[n].value.trim();
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    // maxlength is bypassed on purpose for testing: the server-side rule is checked here
    if (!v('fullName')) return fail(t.errName);
    if (v('fullName').length > 40 || v('bio').length > 200) return fail(t.errLong);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email'))) return fail(t.errEmail);
    if (v('phone') && !/^[0-9+ ]{8,15}$/.test(v('phone'))) return fail(t.errPhone);
    if (v('age') && (isNaN(Number(v('age'))) || Number(v('age')) < 18 || Number(v('age')) > 99)) return fail(t.errAge);
    if (!v('country')) return fail(t.errCountry);
    if (v('visitDate') && !/^\d{2}\/\d{2}\/\d{4}$/.test(v('visitDate'))) return fail('Visit date must be mm/dd/yyyy');
    err.hidden = true; ok.hidden = false;
  });
  document.querySelector('[data-test="logout"]').addEventListener('click', () => { localStorage.removeItem('user'); location.href = '/'; });
  // a tiny read-only date picker (like jQuery UI): the field can't be typed into, only picked
  const vd = document.querySelector('#visitDate'), cal = document.querySelector('#calendar'), sum = document.querySelector('[data-test="visit-summary"]');
  vd.addEventListener('change', () => { sum.textContent = vd.value ? 'Visit on ' + vd.value : ''; });
  // an editable picker (like jQuery UI on a normal input): opens on focus, covers the fields below
  const sd = document.querySelector('#startDate'), cal2 = document.querySelector('#calendar2');
  sd.addEventListener('focus', () => { cal2.hidden = false; });
  sd.addEventListener('keydown', (e) => { if (e.key === 'Escape') cal2.hidden = true; });
  document.addEventListener('mousedown', (e) => { if (!cal2.contains(e.target) && e.target !== sd) cal2.hidden = true; });
  // like jQuery UI: opens on focus, over the fields below; Escape or a click outside closes it
  vd.addEventListener('keydown', (e) => { if (e.key === 'Escape') cal.hidden = true; });
  document.addEventListener('mousedown', (e) => { if (!cal.contains(e.target) && e.target !== vd) cal.hidden = true; });
  vd.addEventListener('focus', () => {
    const now = new Date(), p = (n) => String(n).padStart(2, '0');
    cal.innerHTML = ''; cal.hidden = false;
    for (let d = 1; d <= 28; d++) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = d;
      b.onclick = () => { vd.value = `${p(now.getMonth() + 1)}/${p(d)}/${now.getFullYear()}`; vd.dispatchEvent(new Event('change', { bubbles: true })); cal.hidden = true; };
      cal.appendChild(b);
    }
  });
}

if (document.body.dataset.page === 'cart') {
  if (!localStorage.getItem('user')) location.href = '/';
  document.querySelector('[data-test="continue-shopping"]').addEventListener('click', () => (location.href = '/inventory.html'));
  document.querySelector('[data-test="logout"]').addEventListener('click', () => { localStorage.removeItem('user'); location.href = '/'; });
}

if (document.body.dataset.page === 'inventory') {
  if (!localStorage.getItem('user')) location.href = '/';
  const badge = document.querySelector('[data-test="cart-badge"]');
  let count = 0;
  document.querySelectorAll('[data-test^="add-"]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const added = btn.dataset.state === 'added';
      btn.dataset.state = added ? '' : 'added';
      btn.textContent = added ? t.add : t.remove;
      count += added ? -1 : 1;
      badge.textContent = count || '';
      badge.hidden = !count;
    }),
  );
  document.querySelector('[data-test="logout"]').addEventListener('click', () => {
    localStorage.removeItem('user');
    location.href = '/';
  });
}
