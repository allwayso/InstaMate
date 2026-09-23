/**
 * Keep the assistant reply as spoken dialogue; actions are delivered via play_state.
 * @param {string} text
 */
export function cleanSpokenReply(text) {
  const action =
    '(?:挥手|招手|点头|摇头|眨眼|微笑|轻笑|大笑|笑着|鼓掌|跳舞|转身|耸肩|摊手|动作|表情|wave|nod|smile)';
  const bracketedAction = new RegExp(
    `[（(【\\[][^）)】\\]]{0,24}${action}[^）)】\\]]{0,24}[）)】\\]]`,
    'giu',
  );
  const starredAction = new RegExp(
    `\\*{1,2}[^*]{0,24}${action}[^*]{0,24}\\*{1,2}`,
    'giu',
  );

  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(bracketedAction, '')
    .replace(starredAction, '')
    .replace(
      /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\u200D|\p{Emoji_Modifier}|\p{Extended_Pictographic}|\p{Emoji_Presentation})*/gu,
      '',
    )
    .replace(/[ \t]+([，。！？,.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
