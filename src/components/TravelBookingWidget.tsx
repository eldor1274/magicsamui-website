// 12Go affiliate search form (partner ID 15319268, sub_id magicsamui-guide).
// The widget script is built for plain-HTML embedding, so it runs inside an
// isolated srcDoc iframe; results open on 12go.asia in a new tab.
const WIDGET_HTML = `<body style="margin:0;display:flex;justify-content:center">
<script src="https://cdn0.trainbusferry.com/tools/form/en/?id=15319268&domain=12go.asia" data-one2go="15319268" data-color="default" data-language="en" data-width="100%" data-height="320" data-border="1" data-origin="Koh Samui" data-sub_id="magicsamui-guide" data-domain="12go.asia"></script>
<div id="powered" style="font:12px sans-serif;text-align:center">Powered by <a href="https://12go.asia/?z=15319268&sub_id=magicsamui-guide" target="_blank" rel="noopener noreferrer">12Go system</a></div>
</body>`;

export default function TravelBookingWidget() {
  return (
    <iframe
      srcDoc={WIDGET_HTML}
      title="Search ferries, trains, buses and flights with 12Go"
      loading="lazy"
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      className="h-[420px] w-full max-w-sm border-0"
    />
  );
}
