// 12Go affiliate search form (partner ID 15319268, sub_id magicsamui-guide).
// The widget script needs a real page URL to run (it breaks under srcDoc's
// about:srcdoc origin), so it lives in /12go-widget.html and is framed here;
// results open on 12go.asia in a new tab.
export default function TravelBookingWidget() {
  return (
    <iframe
      src="/12go-widget.html"
      title="Search ferries, trains, buses and flights with 12Go"
      loading="lazy"
      className="h-[420px] w-full max-w-sm border-0"
    />
  );
}
