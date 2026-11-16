// Fails if the inline view's script doesn't parse. tsc can't see inside the String.raw HTML.
import { WIDGET_HTML } from "../dist/core/widget.js";

const script = WIDGET_HTML.split("<script>")[1]?.split("</script>")[0];
if (!script) throw new Error("widget has no <script> block");
new Function(script);
console.log(`widget OK (${WIDGET_HTML.length} chars)`);
