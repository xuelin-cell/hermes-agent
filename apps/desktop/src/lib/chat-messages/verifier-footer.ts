// desktop-mt: 后端在回复存档之后才追加“文件修改核对”英文提醒，只随直播送达、重开即消失；
// 失败的改文件工具行已在对话里标红并随记录保存，桌面版不再重复显示这段提醒。

// 原版格式（agent/turn_explainers.py）：空一行后一行标题，再接缩进的 • 明细行，固定在回复末尾。
const VERIFIER_FOOTER_RE =
  /(?:^|\r?\n[ \t]*\r?\n)[ \t]*⚠️?[ \t]*File-mutation verifier:[^\r\n]*(?:\r?\n[ \t]+•[^\r\n]*)*\s*$/

/** 去掉末尾的文件修改核对提醒；只认回复末尾的原版格式，正文中间引用这句话时原样保留。 */
export function withoutVerifierFooter(text: string): string {
  return text.replace(VERIFIER_FOOTER_RE, '')
}
