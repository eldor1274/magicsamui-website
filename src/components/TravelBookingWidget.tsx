// 12Go affiliate search form (partner ID 15319268, sub_id magicsamui-guide).
// The widget script needs a real page URL to run (it breaks under srcDoc's
// about:srcdoc origin), so it lives in /12go-widget.html and is framed here;
// results open on 12go.asia in a new tab. The script only supports fluid
// width and squeezes below ~500px, so phones get a direct link instead.
export default function TravelBookingWidget() {
  return (
    <>
      <iframe
        src="/12go-widget.html"
        title="Search ferries, trains, buses and flights with 12Go"
        loading="lazy"
        className="hidden h-[360px] w-full max-w-xl border-0 sm:block"
      />
      <a
        href="https://12go.asia/en?z=15319268&sub_id=magicsamui-guide"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-full bg-pool px-6 py-3 text-sm font-medium text-white hover:bg-pool-dark sm:hidden"
      >
        Search tickets on 12Go →
      </a>
    </>
  );
}
