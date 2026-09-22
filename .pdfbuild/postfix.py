"""postfix.py — 给 pandoc 生成的 HTML 打补丁：
1) 6 列「队员信息」表改为固定列宽布局（否则 CJK 表格被压成一字一行）
2) 注入打印用中文字体与分页规则
用法: python .pdfbuild/postfix.py  (需已存在 .pdfbuild/raw.html)
"""
import re

SRC = '.pdfbuild/raw.html'
DST = '.pdfbuild/proposal.html'

# A4 可用宽度约 182mm，6 列合计 100%
WIDTHS = ['9%', '8%', '12.5%', '28%', '24%', '18.5%']

EXTRA_CSS = """
<style>
table.members { table-layout: fixed; font-size: 8.2pt; }
table.members th, table.members td {
  padding: 3pt 3.5pt;
  word-break: break-word;
  overflow-wrap: anywhere;
}
/* 序号列与联系方式列不允许折行（手机号必须完整成串，序号「1（队长）」不竖排） */
table.members th:nth-child(1), table.members td:nth-child(1) {
  white-space: nowrap; font-size: 7.6pt; text-align: center;
}
table.members th:nth-child(2), table.members td:nth-child(2) { white-space: nowrap; }
table.members th:nth-child(6), table.members td:nth-child(6) {
  white-space: nowrap; font-size: 7.6pt;
}
</style>
</head>"""


def patch_table(match: 're.Match') -> str:
    table = match.group(0)
    if '分工角色' not in table:
        return table
    cols = ''.join(f'<col style="width:{w}" />' for w in WIDTHS)
    open_tag = re.search(r'<table[^>]*>', table).group(0)
    return table.replace(open_tag, f'<table class="members"><colgroup>{cols}</colgroup>', 1)


def main() -> None:
    html = open(SRC, encoding='utf-8').read()
    html = re.sub(r'<table[^>]*>.*?</table>', patch_table, html, flags=re.S)
    assert 'class="members"' in html, '未找到「队员信息」表，请检查 Proposal.md 的表头'
    assert '</head>' in html, 'HTML 缺少 </head>'
    html = html.replace('</head>', EXTRA_CSS, 1)
    open(DST, 'w', encoding='utf-8').write(html)
    print('postfix ok ->', DST)


if __name__ == '__main__':
    main()
