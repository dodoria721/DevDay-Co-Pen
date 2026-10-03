/**
 * L4 출력 정화.
 * 모델 출력에서 외부로 데이터를 내보낼 수 있는 형식(URL, 마크다운 이미지·링크, HTML)과
 * 연쇄 호출을 일으킬 수 있는 멘션을 지우고, 전체 길이를 제한한다.
 * 문서에는 Yjs 텍스트(plain text)로만 들어가므로 서식·태그로 해석될 여지가 없다.
 */

export const MAX_OUTPUT_CHARS = 4000;
export const LINK_PLACEHOLDER = '[링크 삭제됨]';

export class OutputSanitizationError extends Error {
  constructor(readonly code: 'output_too_large' | 'output_sanitization_failed') {
    super(code);
  }
}

/** 스트림에서 판단을 미룰 수 있는 최대 길이. 넘으면 닫히지 않은 구문이 있어도 정화해서 내보낸다. */
const MAX_HOLD_CHARS = 300;

const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\([^)\n]*\)/g;
const HTML_TAG = /<\/?[a-z!][^>]*>/gi;
const SCHEME_URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const INLINE_SCHEME = /\b(?:javascript|vbscript|data|mailto|file):\S*/gi;
const WWW_URL = /\bwww\.\S+/gi;
const BARE_DOMAIN_PATH = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi;
/** "@AI 요청" 형태가 AI 문단에 남으면 사람이 Enter만 쳐도 새 작업이 된다 */
const MENTION_MARK = /[@＠](?=AI|초안)/gi;

export function sanitizeText(text: string): string {
  return text
    .replace(INVISIBLE, '')
    .replace(MARKDOWN_IMAGE, '')
    .replace(MARKDOWN_LINK, '$1')
    .replace(HTML_TAG, '')
    .replace(SCHEME_URL, LINK_PLACEHOLDER)
    .replace(INLINE_SCHEME, LINK_PLACEHOLDER)
    .replace(WWW_URL, LINK_PLACEHOLDER)
    .replace(BARE_DOMAIN_PATH, LINK_PLACEHOLDER)
    .replace(MENTION_MARK, '');
}

/**
 * 토큰 단위 스트림을 공백 경계에서 끊어 정화한다.
 * URL은 공백을 포함하지 않으므로 공백 경계면 충분하고,
 * `<태그 ...>`·`[글](주소)`처럼 공백을 품는 구문은 닫힐 때까지 붙잡아 둔다.
 */
export class StreamSanitizer {
  private pending = '';
  private emitted = 0;

  push(chunk: string): string {
    if (typeof chunk !== 'string') throw new OutputSanitizationError('output_sanitization_failed');
    this.pending += chunk;

    const cut = this.pending.length > MAX_HOLD_CHARS ? this.pending.length : safeCut(this.pending);
    if (cut <= 0) return '';
    const ready = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return this.limit(sanitizeText(ready));
  }

  end(): string {
    const rest = this.pending;
    this.pending = '';
    return this.limit(sanitizeText(rest));
  }

  private limit(text: string): string {
    if (this.emitted + text.length > MAX_OUTPUT_CHARS) {
      throw new OutputSanitizationError('output_too_large');
    }
    this.emitted += text.length;
    return text;
  }
}

/** 지금 내보내도 되는 앞부분의 길이. 마지막 공백 뒤와 닫히지 않은 구문은 남긴다. */
function safeCut(text: string): number {
  let cut = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n'), text.lastIndexOf('\t')) + 1;

  const openers = [unclosed(text, '<', '>'), unclosed(text, '[', ']'), unclosed(text, '](', ')')];
  for (let open of openers) {
    if (open < 0) continue;
    // 닫히지 않은 `]( ... ` 는 그 앞의 `[`(이미지면 `![`)부터 붙잡는다
    if (text.startsWith('](', open)) open = Math.max(0, text.lastIndexOf('[', open));
    if (text[open] === '[' && text[open - 1] === '!') open -= 1;
    cut = Math.min(cut, open);
  }
  return cut;
}

function unclosed(text: string, open: string, close: string): number {
  const index = text.lastIndexOf(open);
  if (index < 0) return -1;
  return text.indexOf(close, index + open.length) < 0 ? index : -1;
}
