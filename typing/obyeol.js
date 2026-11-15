// Art derived from the supplied V5 assets/obyeol.svg; parts share one connected body.
const artwork = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 510" role="img" aria-label="학교 마스코트 오별이">
  <defs>
    <radialGradient id="__ID__-cheek"><stop stop-color="#ff8b92" stop-opacity=".65" /><stop offset="1" stop-color="#ff8b92" stop-opacity="0" /></radialGradient>
    <linearGradient id="__ID__-head" x1="0" y1="0" x2=".85" y2="1"><stop stop-color="#ffe993" /><stop offset=".7" stop-color="#ffdf70" /><stop offset="1" stop-color="#ffd45f" /></linearGradient>
  </defs>

  <ellipse cx="231" cy="463" rx="111" ry="13" fill="#e9b842" opacity=".21" class="ob-shadow" />

  <g class="ob-float"><g class="ob-body"><path d="M186 430 Q179 444 182 459 Q192 466 212 460 L218 441 M252 442 L254 458 Q274 464 283 458 Q284 445 276 430" fill="#fffefb" stroke="#28231f" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" />

  <path d="M169 258 C145 260 122 276 110 305 Q96 335 109 355 Q121 371 140 360 Q149 354 158 340 L162 413 Q162 443 188 449 Q228 459 274 449 Q299 445 300 416 L304 341 Q313 357 326 362 Q342 368 353 350 Q361 335 344 301 C329 273 309 257 284 258 C250 255 205 255 169 258Z" fill="#fffefa" stroke="#28231f" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" />
  <g class="ob-hand ob-hand-left"><path d="M115 334 Q100 336 98 350 Q96 368 112 374 Q133 380 147 360 Q153 349 143 339 Q131 329 115 334Z" fill="#fffefa" stroke="#28231f" stroke-width="6" />
  </g><g class="ob-hand ob-hand-right"><path d="M340 332 Q357 330 364 345 Q371 363 354 373 Q338 381 324 364 Q314 351 325 340 Q331 334 340 332Z" fill="#fffefa" stroke="#28231f" stroke-width="6" />

  </g><circle cx="231" cy="342" r="5" fill="none" stroke="#28231f" stroke-width="4" />
  <text x="231" y="390" font-family="Arial,sans-serif" text-anchor="middle" font-size="30" font-weight="800" fill="#28231f">S</text>

  <g class="ob-head"><path d="M55 177 C44 141 42 76 63 51 C83 27 124 44 154 57 C183 70 203 88 219 109 C243 72 286 27 334 29 C370 30 384 64 376 112 C373 135 368 149 363 161 C397 172 420 188 420 217 C420 254 371 279 303 291 C238 305 158 298 92 282 C44 269 20 246 24 218 C27 196 39 186 55 177Z" fill="url(#__ID__-head)" stroke="#28231f" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
  <ellipse cx="100" cy="234" rx="41" ry="32" fill="url(#__ID__-cheek)" />
  <ellipse cx="343" cy="234" rx="41" ry="32" fill="url(#__ID__-cheek)" />
  <path d="M119 130 Q127 108 146 126 M285 126 Q294 104 312 128" fill="none" stroke="#28231f" stroke-width="6" stroke-linecap="round" class="ob-brows" />
  <g class="ob-eye ob-eye-left"><g transform="rotate(-12 146 195)">
    <ellipse cx="146" cy="195" rx="43" ry="41" fill="#fff" stroke="#201d1a" stroke-width="8" />
    <path d="M109 199 Q142 192 184 192" fill="none" stroke="#201d1a" stroke-width="15" stroke-linecap="round" />
  </g>
  </g><g class="ob-eye ob-eye-right"><g transform="rotate(-10 292 192)">
    <ellipse cx="292" cy="192" rx="43" ry="41" fill="#fff" stroke="#201d1a" stroke-width="8" />
    <path d="M255 198 Q290 190 331 190" fill="none" stroke="#201d1a" stroke-width="15" stroke-linecap="round" />
  </g>
  </g><path d="M208 226 Q227 237 249 222 L249 251 C249 281 236 292 223 280 C211 269 208 248 208 226Z" fill="#ff9db1" stroke="#28231f" stroke-width="6" stroke-linejoin="round" class="ob-mouth ob-mouth-smile" />
  <path d="M78 234 L68 251 M94 241 L85 258 M109 247 L102 263 M345 235 L351 251 M359 234 L367 250 M372 232 L383 248" stroke="#28231f" stroke-width="5" stroke-linecap="round" />
<ellipse class="ob-mouth ob-mouth-surprise" cx="230" cy="251" rx="14" ry="19" fill="#ff9db1" stroke="#28231f" stroke-width="6" /><path class="ob-mouth ob-mouth-pout" d="M210 252 Q230 241 250 252" fill="none" stroke="#28231f" stroke-width="6" stroke-linecap="round" /><path class="ob-angry-brows" d="M116 131 L151 141 M280 139 L315 126" fill="none" stroke="#28231f" stroke-width="6" stroke-linecap="round" /></g></g></g></svg>`;
let instance = 0;
export function mountObyeol(container, caption) {
  container.innerHTML = artwork.replaceAll('__ID__', `obyeol-${++instance}`);
  let good = 0;
  let mistakes = 0;
  const labels = {
    idle: '입력을 기다리고 있어요',
    focus: '한 글자씩, 차근차근!',
    happy: '좋아요! 정확하게 이어가요',
    surprised: '앗! 다시 확인해 볼까요?',
    angry: '으음… 천천히 해도 괜찮아요',
    complete: '완성! 수고했어요',
    paused: '잠시 멈췄어요',
  };
  function mood(value) {
    if (container.dataset.mood === value) return;
    container.dataset.mood = value;
    if (caption) caption.textContent = labels[value];
  }
  return {
    react(previous, current, edit) {
      // Intermediate Korean jamo never drives an error expression.
      if (current.composing || previous.committed === current.committed) return;
      const addedErrors = current.errors - previous.errors;
      if (addedErrors > 0) {
        good = 0;
        mistakes += addedErrors;
        mood(mistakes >= 2 ? 'angry' : 'surprised');
      } else if (!edit?.inputType?.startsWith('delete') &&
        !(previous.composing && previous.compositionHasDeletion && !previous.compositionHasInsertion) &&
        (edit?.inputType?.startsWith('insert') || previous.compositionHasInsertion ||
          Array.from(current.committed).length >= Array.from(previous.committed).length)) {
        mistakes = 0;
        good++;
        mood(good >= 8 ? 'happy' : 'focus');
      }
    },
    complete() { mood('complete'); },
    pause() { mood('paused'); },
    reset() { good = 0; mistakes = 0; mood('idle'); },
  };
}
