// 韩语发音规则 / 罗马字单测：node tests/test_hangul.mjs（pytest 会自动调用）
import assert from 'node:assert/strict';
import { romanizeKorean, pronounceKorean, koreanWords } from '../static/js/hangul.js';

const cases = {
  // 原文: [发音韩文, 罗马字]
  '같아': ['가타', 'gata'],
  '찾는': ['찬는', 'channeun'],
  '잊혀지지': ['이쳐지지', 'ichyeojiji'],
  '않아': ['아나', 'ana'],
  '알잖아': ['알자나', 'aljana'],
  '기억해': ['기어캐', 'gieokae'],
  '손을': ['소늘', 'soneul'],
  '끝이나면': ['끄치나면', 'kkeuchinamyeon'],
  '들린': ['들린', 'deullin'],
  '있길': ['있길', 'itgil'],
  '없어': ['업써', 'eopsseo'],
  '합니다': ['함니다', 'hamnida'],
  '신라': ['실라', 'silla'],
  '종로': ['종노', 'jongno'],
  '국립': ['궁닙', 'gungnip'],
  '좋습니다': ['조씀니다', 'josseumnida'],
  '닫히다': ['다치다', 'dachida'],
  '사랑해': ['사랑해', 'saranghae'],
  '괜찮아': ['괜차나', 'gwaenchana'],
};
for (const [src, [pron, rr]] of Object.entries(cases)) {
  assert.equal(pronounceKorean(src), pron, `发音 ${src}`);
  assert.equal(romanizeKorean(src), rr, `罗马字 ${src}`);
  assert.equal(romanizeKorean(pron), rr, `发音形式再转罗马字应一致 ${src}`);
}
const line = '(날 기억해) 절대 잊지 않아...';
const words = koreanWords(line);
assert.equal(words.map(w => w.t).join(''), line);
assert.equal(words.filter(w => !w.p).map(w => w.r).join(' '), 'nal gieokae jeoldae itji ana');
assert.equal(koreanWords('I missed you all day').filter(w => !w.p).map(w => w.r).join(' '), 'I missed you all day');
console.log('hangul ok');
