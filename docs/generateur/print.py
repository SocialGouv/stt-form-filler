import asyncio, sys
from playwright.async_api import async_playwright
SRC, OUT = sys.argv[1], sys.argv[2]
FOOT = """<div style="width:100%;font-family:Arial,sans-serif;font-size:8px;color:#666;padding:0 16mm;display:flex;justify-content:space-between">
<span>Formulaire MDPH - Partie B — Spécifications fonctionnelles et notice technique</span>
<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>"""
async def run():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        page = await b.new_page()
        await page.goto(f"file://{SRC}", wait_until="networkidle")
        await page.evaluate("document.fonts.ready")
        await page.wait_for_timeout(800)
        await page.pdf(path=OUT, format="A4", print_background=True, prefer_css_page_size=True,
                       display_header_footer=True, header_template="<span></span>", footer_template=FOOT,
                       margin={"top": "20mm", "bottom": "18mm", "left": "16mm", "right": "16mm"},
                       tagged=True, outline=True)
        await b.close()
asyncio.run(run())