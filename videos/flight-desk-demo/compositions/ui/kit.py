# Shared look for the animated scenes. Tokens are lifted from the app's own
# globals.css; sizes are scaled up ~1.5x because a 14px label that is fine in a
# browser is unreadable in a 1920-wide video played in a small window.
CSS = """
      .ap { position:absolute; inset:0; background:#16150f; color:#efece4;
            font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
      .ap .mono { font-family:ui-monospace,monospace; }
      .ap .mast { display:flex; align-items:baseline; gap:18px; padding:34px 60px 24px;
                  border-bottom:1px solid #35332a; }
      .ap .mast h1 { font-size:26px; font-weight:620; letter-spacing:-.01em; }
      .ap .mast .sub { font-size:19px; color:#9c968c; }
      .ap .chip { margin-left:auto; font-family:ui-monospace,monospace; font-size:16px;
                  letter-spacing:.06em; text-transform:uppercase; color:#a29d90;
                  border:1px solid #35332a; border-radius:999px; padding:6px 16px; }
      .ap .split { display:grid; grid-template-columns:640px 1px 1fr; height:calc(1080px - 92px); }
      .ap .rail { padding:34px 40px; overflow:hidden; }
      .ap .vr { background:#35332a; }
      .ap .pane { padding:28px 44px; overflow:hidden; position:relative; }

      .ap .bubble { background:#6fc3a4; color:#10201a; padding:16px 22px; border-radius:12px;
                    font-size:22px; line-height:1.45; margin-left:auto; max-width:520px; }
      .ap .say { font-size:22px; line-height:1.55; margin-top:26px; color:#efece4; }
      .ap .say b { color:#efece4; font-weight:640; }
      .ap .trace { font-family:ui-monospace,monospace; font-size:17px; color:#9c968c; margin-top:18px; }

      .ap .fc { border:1px solid #35332a; border-radius:14px; background:#1e1d17;
                padding:22px 26px; margin-bottom:16px; }
      .ap .fc-top { display:flex; align-items:center; gap:14px; }
      .ap .fc-mark { width:40px; height:40px; border-radius:9px; background:#252419;
                     display:grid; place-items:center; font-size:17px; font-weight:700;
                     font-family:ui-monospace,monospace; color:#efece4; }
      .ap .fc-no { font-family:ui-monospace,monospace; font-size:17px; color:#9c968c; }
      .ap .fc-price { margin-left:auto; font-size:34px; font-weight:640; letter-spacing:-.02em; }
      .ap .fc-price small { font-size:16px; color:#9c968c; font-weight:400; margin-left:6px; }
      .ap .fc-row { display:flex; align-items:baseline; gap:22px; margin-top:16px; }
      .ap .fc-od { font-size:17px; color:#a29d90; font-family:ui-monospace,monospace; }
      .ap .fc-t { font-size:30px; font-weight:600; letter-spacing:-.01em; }
      .ap .fc-line { flex:1; height:1px; background:#35332a; margin:0 6px; position:relative; top:-6px; }
      .ap .tags { display:flex; gap:8px; flex-wrap:wrap; margin-top:16px; }
      .ap .pill { font-family:ui-monospace,monospace; font-size:15px; padding:5px 12px;
                  border-radius:999px; border:1px solid #35332a; color:#a29d90; }
      .ap .pill.ok { border-color:#6fc3a4; color:#6fc3a4; }
      .ap .pill.warn { border-color:#d9a94f; color:#d9a94f; }

      .ap .card { border:1px solid #35332a; border-radius:14px; background:#1e1d17; overflow:hidden; }
      .ap .card-h { display:flex; justify-content:space-between; align-items:center;
                    padding:16px 24px; background:#252419; border-bottom:1px solid #35332a;
                    font-family:ui-monospace,monospace; font-size:16px; letter-spacing:.05em;
                    text-transform:uppercase; color:#a29d90; }
      .ap .card-b { padding:24px; }
      .ap .kv { display:flex; justify-content:space-between; font-size:21px; padding:9px 0; }
      .ap .kv .k { color:#a29d90; }
      .ap .kv.total { font-size:26px; font-weight:640; border-top:1px solid #35332a;
                      margin-top:10px; padding-top:16px; }
      .ap .btn { display:inline-block; background:#6fc3a4; color:#10201a; font-weight:640;
                 font-size:22px; padding:15px 26px; border-radius:10px; }
      .ap .note { font-size:18px; color:#9c968c; line-height:1.5; margin-top:14px; }

      .ap .step { display:flex; gap:16px; padding:13px 0; }
      .ap .step-m { width:30px; height:30px; border-radius:50%; border:1.5px solid #4a4739;
                    display:grid; place-items:center; font-family:ui-monospace,monospace;
                    font-size:15px; color:#9c968c; flex:none; }
      .ap .step.on .step-m { border-color:#6fc3a4; color:#6fc3a4; }
      .ap .step.done .step-m { border-color:#6fc3a4; color:#6fc3a4; }
      .ap .step-t { font-size:21px; color:#a29d90; }
      .ap .step.on .step-t { color:#efece4; font-weight:620; }
      .ap .outcome { display:flex; gap:16px; align-items:flex-start; margin-top:18px;
                     padding:20px 22px; border-radius:12px; border:1px solid #6fc3a4;
                     background:#1b2f27; }
      .ap .outcome-m { width:36px; height:36px; border-radius:50%; border:2px solid #6fc3a4;
                       display:grid; place-items:center; color:#6fc3a4; font-size:19px; flex:none; }
      .ap .outcome-t { font-size:26px; font-weight:640; }
      .ap .outcome-s { font-size:20px; color:#a29d90; margin-top:4px; }
      .ap .outcome-s b { font-family:ui-monospace,monospace; color:#efece4; }
"""

def scene(cid, body, js):
    return f"""<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /></head>
  <body>
    <template>
      <style>{CSS}</style>
      <div id="{cid}" data-composition-id="{cid}" data-width="1920" data-height="1080"
           style="position:relative;width:1920px;height:1080px;background:#16150f">
{body}
      </div>
      <script>
        (function () {{
          const tl = gsap.timeline({{ paused: true }});
{js}
          window.__timelines["{cid}"] = tl;
        }})();
      </script>
    </template>
  </body>
</html>
"""

def mast(chip="ATLAS SANDBOX"):
    return f'''          <div class="mast">
            <h1>FluxA Flight Desk</h1><span class="sub">search &middot; price &middot; book &middot; manage</span>
            <span class="chip">{chip}</span>
          </div>'''

def fcard(idx, carrier, no, price, dep_t, dep_a, arr_t, arr_a, dur, tags, extra=""):
    tg = "".join(f'<span class="pill {c}">{t}</span>' for t, c in tags)
    return f'''            <div class="fc" id="fc{idx}" style="opacity:0"{extra}>
              <div class="fc-top">
                <div class="fc-mark">{carrier}</div>
                <div class="fc-no">{no}</div>
                <div class="fc-price">{price}<small>USDC</small></div>
              </div>
              <div class="fc-row">
                <div><div class="fc-od">{dep_a}</div><div class="fc-t">{dep_t}</div></div>
                <div class="fc-line"></div>
                <div style="text-align:center"><div class="fc-od">{dur}</div></div>
                <div class="fc-line"></div>
                <div style="text-align:right"><div class="fc-od">{arr_a}</div><div class="fc-t">{arr_t}</div></div>
              </div>
              <div class="tags">{tg}</div>
            </div>'''
