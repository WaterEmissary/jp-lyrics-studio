// 韩语：按实际发音规则转换成罗马字（国语罗马字表记法 Revised Romanization，按发音转写）。
//
// 歌词里写的字和唱出来的音不一样（연음 连音、비음화 鼻音化、유음화 流音化、격음화 送气化、구개음화 腭化、ㅎ 脱落……），
// 所以先把「写法」变成「发音」（音节数不变，例：잊혀지지 않아 → 이쳐지지 아나，같아 → 가타，찾는 → 찬는），
// 再逐音节转成罗马字：ichyeojiji ana / gata / channeun。
//
// 两种用法：
//   pronounceKorean(text)          发音韩文：给歌词上方「注音」显示（只改变真正听得出来的音变，不做收音中和与紧音化）
//   romanizeKorean(text)           罗马字：分析时用于 word.r；对已经是发音形式的文本再转一次结果不变
// 规则只在一个词（空格分隔的 어절）内部应用；跨词的连读不处理（与 RR 一致）。

const S_BASE = 0xac00;
const S_END = 0xd7a3;
const INITIALS = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const VOWELS = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const FINALS = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

const RR_INITIAL = {
  'ㄱ': 'g', 'ㄲ': 'kk', 'ㄴ': 'n', 'ㄷ': 'd', 'ㄸ': 'tt', 'ㄹ': 'r', 'ㅁ': 'm', 'ㅂ': 'b', 'ㅃ': 'pp', 'ㅅ': 's',
  'ㅆ': 'ss', 'ㅇ': '', 'ㅈ': 'j', 'ㅉ': 'jj', 'ㅊ': 'ch', 'ㅋ': 'k', 'ㅌ': 't', 'ㅍ': 'p', 'ㅎ': 'h',
};
const RR_VOWEL = {
  'ㅏ': 'a', 'ㅐ': 'ae', 'ㅑ': 'ya', 'ㅒ': 'yae', 'ㅓ': 'eo', 'ㅔ': 'e', 'ㅕ': 'yeo', 'ㅖ': 'ye', 'ㅗ': 'o', 'ㅘ': 'wa',
  'ㅙ': 'wae', 'ㅚ': 'oe', 'ㅛ': 'yo', 'ㅜ': 'u', 'ㅝ': 'wo', 'ㅞ': 'we', 'ㅟ': 'wi', 'ㅠ': 'yu', 'ㅡ': 'eu', 'ㅢ': 'ui', 'ㅣ': 'i',
};
// 收音（代表音）：词末或辅音前只有 7 种发音
const NEUTRAL = {
  'ㄱ': 'ㄱ', 'ㄲ': 'ㄱ', 'ㅋ': 'ㄱ', 'ㄳ': 'ㄱ', 'ㄺ': 'ㄱ',
  'ㄴ': 'ㄴ', 'ㄵ': 'ㄴ', 'ㄶ': 'ㄴ',
  'ㄷ': 'ㄷ', 'ㅅ': 'ㄷ', 'ㅆ': 'ㄷ', 'ㅈ': 'ㄷ', 'ㅊ': 'ㄷ', 'ㅌ': 'ㄷ', 'ㅎ': 'ㄷ',
  'ㄹ': 'ㄹ', 'ㄼ': 'ㄹ', 'ㄽ': 'ㄹ', 'ㄾ': 'ㄹ', 'ㅀ': 'ㄹ',
  'ㅁ': 'ㅁ', 'ㄻ': 'ㅁ',
  'ㅂ': 'ㅂ', 'ㅍ': 'ㅂ', 'ㅄ': 'ㅂ', 'ㄿ': 'ㅂ',
  'ㅇ': 'ㅇ',
};
const RR_FINAL = { '': '', 'ㄱ': 'k', 'ㄴ': 'n', 'ㄷ': 't', 'ㄹ': 'l', 'ㅁ': 'm', 'ㅂ': 'p', 'ㅇ': 'ng' };
// 双收音：留在本音节的 + 移到下一音节的（连音时；ㅅ 移过去读 ㅆ）
const DOUBLE = {
  'ㄳ': ['ㄱ', 'ㅆ'], 'ㄵ': ['ㄴ', 'ㅈ'], 'ㄶ': ['ㄴ', 'ㅎ'], 'ㄺ': ['ㄹ', 'ㄱ'], 'ㄻ': ['ㄹ', 'ㅁ'], 'ㄼ': ['ㄹ', 'ㅂ'],
  'ㄽ': ['ㄹ', 'ㅆ'], 'ㄾ': ['ㄹ', 'ㅌ'], 'ㄿ': ['ㄹ', 'ㅍ'], 'ㅀ': ['ㄹ', 'ㅎ'], 'ㅄ': ['ㅂ', 'ㅆ'],
};
const ASPIRATE = { 'ㄱ': 'ㅋ', 'ㄷ': 'ㅌ', 'ㅂ': 'ㅍ', 'ㅈ': 'ㅊ' };

export const RE_HANGUL = /[가-힣ㄱ-ㆎ]/;
export const hasHangul = (s) => RE_HANGUL.test(String(s || ''));

function decompose(ch) {
  const code = ch.codePointAt(0);
  if (code < S_BASE || code > S_END) return null;
  const idx = code - S_BASE;
  return { i: INITIALS[Math.floor(idx / 588)], v: VOWELS[Math.floor((idx % 588) / 28)], f: FINALS[idx % 28] };
}

function compose(s) {
  const fi = FINALS.indexOf(s.f);
  return String.fromCodePoint(S_BASE + INITIALS.indexOf(s.i) * 588 + VOWELS.indexOf(s.v) * 28 + (fi < 0 ? 0 : fi));
}

/**
 * 对一串连续的音节（同一个词内）应用发音规则。
 * neutral=true：辅音前的收音也换成代表音（罗马字用）；false：只改听得出来的变化（注音显示用）。
 */
function applyRules(syl, { neutral }) {
  for (let j = 0; j < syl.length - 1; j++) {
    const cur = syl[j];
    const nxt = syl[j + 1];
    const f = cur.f;
    if (!f) continue;
    const n = nxt.i;

    // ---- 后面是元音开头（ㅇ）：连音
    if (n === 'ㅇ') {
      if (f === 'ㅇ') continue;
      if (f === 'ㅎ') { cur.f = ''; continue; }                         // 좋아 → 조아
      if (f === 'ㄶ' || f === 'ㅀ') { cur.f = ''; nxt.i = DOUBLE[f][0]; continue; }   // 않아 → 아나，싫어 → 시러
      if (DOUBLE[f]) { cur.f = DOUBLE[f][0]; nxt.i = DOUBLE[f][1]; }    // 없어 → 업써，읽어 → 일거
      else { cur.f = ''; nxt.i = f; }                                    // 손을 → 소늘，있어 → 이써
      // 腭化：ㄷ/ㅌ + 이 → 지/치（굳이 → 구지，같이 → 가치）
      if (nxt.v === 'ㅣ' && (nxt.i === 'ㄷ' || nxt.i === 'ㅌ')) nxt.i = nxt.i === 'ㄷ' ? 'ㅈ' : 'ㅊ';
      continue;
    }

    // ---- ㅎ 收音（ㅎ ㄶ ㅀ）后接辅音
    if (f === 'ㅎ' || f === 'ㄶ' || f === 'ㅀ') {
      const rest = f === 'ㅎ' ? '' : DOUBLE[f][0];
      if (ASPIRATE[n]) { cur.f = rest; nxt.i = ASPIRATE[n]; }           // 좋고 → 조코，않다 → 안타
      else if (n === 'ㅅ') { cur.f = rest; nxt.i = 'ㅆ'; }               // 좋습니다 → 조씀니다
      else if (n === 'ㄴ') { cur.f = rest || 'ㄴ'; }                     // 놓는 → 논는，싫네 → 실레（下面流音化）
      else cur.f = rest || (neutral ? 'ㄷ' : f);
      if (cur.f === 'ㄹ' && nxt.i === 'ㄴ') nxt.i = 'ㄹ';
      continue;
    }

    // ---- 送气化：ㄱ/ㄷ/ㅂ/ㅈ 类收音 + ㅎ（축하 → 추카，잊혀 → 이쳐，못해 → 모태，앉히다 → 안치다，밟히다 → 발피다）
    if (n === 'ㅎ') {
      let stay = null;
      let src = null;
      if (f === 'ㄵ') { stay = 'ㄴ'; src = 'ㅈ'; }
      else if (f === 'ㄺ' || f === 'ㄼ') { stay = 'ㄹ'; src = DOUBLE[f][1]; }
      else if (['ㄱ', 'ㄷ', 'ㅂ'].includes(NEUTRAL[f])) { stay = ''; src = f; }
      if (src !== null) {
        cur.f = stay;
        nxt.i = ['ㅈ', 'ㅊ'].includes(src) ? 'ㅊ' : ASPIRATE[NEUTRAL[src]];
        if (nxt.v === 'ㅣ' && nxt.i === 'ㅌ') nxt.i = 'ㅊ';              // 닫히다 → 다치다
        continue;
      }
    }

    // ---- 其它辅音前：先取代表音
    let nf = NEUTRAL[f] || f;
    if (f === 'ㄺ' && n === 'ㄱ') nf = 'ㄹ';                              // 읽고 → 일꼬
    let changed = false;
    if (['ㄱ', 'ㄷ', 'ㅂ'].includes(nf) && (n === 'ㄴ' || n === 'ㅁ')) {     // 鼻音化：합니다 → 함니다，찾는 → 찬는
      nf = { 'ㄱ': 'ㅇ', 'ㄷ': 'ㄴ', 'ㅂ': 'ㅁ' }[nf];
      changed = true;
    } else if (n === 'ㄹ') {
      if (nf === 'ㄴ') { nf = 'ㄹ'; changed = true; }                      // 신라 → 실라
      else if (nf === 'ㅁ' || nf === 'ㅇ') { nxt.i = 'ㄴ'; }               // 종로 → 종노
      else if (['ㄱ', 'ㄷ', 'ㅂ'].includes(nf)) {                          // 국립 → 궁닙
        nf = { 'ㄱ': 'ㅇ', 'ㄷ': 'ㄴ', 'ㅂ': 'ㅁ' }[nf];
        nxt.i = 'ㄴ';
        changed = true;
      }
    } else if (nf === 'ㄹ' && n === 'ㄴ') {                                 // 설날 → 설랄
      nxt.i = 'ㄹ';
    }
    if (neutral || changed) cur.f = nf;
  }
  return syl;
}

/** 把文本中每段连续的韩文音节应用发音规则；非韩文字符原样保留（字数不变） */
function transform(text, opts) {
  const chars = [...String(text || '')];
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    applyRules(run, opts);
    out.push(...run.map(compose));
    run = [];
  };
  for (const ch of chars) {
    const s = decompose(ch);
    if (s) run.push(s);
    else { flush(); out.push(ch); }
  }
  flush();
  return out.join('');
}

/** 发音韩文（注音显示用）：잊혀지지 → 이쳐지지，같아 → 가타，않아 → 아나 */
export function pronounceKorean(text) {
  return transform(text, { neutral: false });
}

/** 韩文 → 罗马字（按发音，RR）。非韩文字符原样保留。 */
export function romanizeKorean(text) {
  const chars = [...String(text || '')];
  let out = '';
  let run = [];
  const flush = () => {
    if (!run.length) return;
    applyRules(run, { neutral: true });
    run.forEach((s, j) => {
      const prevF = j > 0 ? run[j - 1].f : '';
      // ㄹㄹ 写作 ll（들린 → deullin），其它 ㄹ 初声写 r
      const ini = s.i === 'ㄹ' && NEUTRAL[prevF] === 'ㄹ' ? 'l' : RR_INITIAL[s.i];
      out += ini + RR_VOWEL[s.v] + RR_FINAL[NEUTRAL[s.f] || ''];
    });
    run = [];
  };
  for (const ch of chars) {
    const s = decompose(ch);
    if (s) run.push(s);
    else { flush(); out += ch; }
  }
  flush();
  return out;
}

/**
 * 一行韩语歌词 → words[]（与日语分析结果同样的结构，保证 words.map(w => w.t).join('') === text）：
 *   韩文词（空格分隔）{t, k: 发音韩文, r: 罗马字}；英文 {t, k: '', r: t}；空白与标点 {t, p: 1}
 */
export function koreanWords(text) {
  const src = String(text || '');
  const words = [];
  const re = /([가-힣ㄱ-ㆎ]+)|([A-Za-z0-9'’]+)|(\s+)|([^\sA-Za-z0-9가-힣ㄱ-ㆎ]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) {
      // 韩文后面紧跟的英文 / 数字也算同一个词里（如「OK야」），按出现顺序各自成词即可
      words.push({ t: m[1], k: pronounceKorean(m[1]), r: romanizeKorean(m[1]) });
    } else if (m[2]) {
      words.push({ t: m[2], k: '', r: m[2] });
    } else {
      words.push({ t: m[0], k: '', r: '', p: 1 });
    }
  }
  return words;
}

/** 注音 HTML：只在发音与写法不同的音节上方标出发音（音节一一对应；对不上时整词标注） */
export function koreanRubyHTML(surface, reading, esc = (s) => s) {
  const t = [...String(surface || '')];
  const k = [...String(reading || '')];
  if (!reading || reading === surface) return esc(surface);
  if (t.length !== k.length) return `<ruby>${esc(surface)}<rt>${esc(reading)}</rt></ruby>`;
  return t.map((ch, i) => (ch === k[i] ? esc(ch) : `<ruby>${esc(ch)}<rt>${esc(k[i])}</rt></ruby>`)).join('');
}
