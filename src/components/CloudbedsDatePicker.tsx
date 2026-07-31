import { site } from "@/data/site";

export default function CloudbedsDatePicker({ className = "" }: { className?: string }) {
  return (
    <div className={className}>
      <cb-property-date-picker
        property-code={site.cloudbedsPropertyCode}
        button-label="Check Availability"
        layout="horizontal"
        open-in-new-tab="true"
      />
    </div>
  );
}
