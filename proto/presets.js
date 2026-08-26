// Charset presets shared by the phase-0 sandbox and the live page.
export const PRESETS = {
  ascii10: ' .:-=+*#%@',
  ascii70: " .'`^\",:;Il!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  cyrillic: ' .,-:;тлпнсоеавыкзмджчцшщХЖМШЩ@',
  // Written light->dark for readability, but the atlas re-sorts by measured ink
  // anyway; fullwidth glyphs are auto-shrunk to fit the cell (ascii.js).
  japanese: ' ・。、ーノつくめの一二人十七日口中今木水火田目年花虫魚金雨語電駅銀機闇龍響鬱',
  blocks: ' ▁▂▃▄▅▆▇█',
};
