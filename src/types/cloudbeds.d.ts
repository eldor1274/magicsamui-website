import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "cb-property-date-picker": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          "property-code"?: string;
          "button-label"?: string;
          layout?: "horizontal" | "vertical";
          "open-in-new-tab"?: "true" | "false";
          lang?: string;
          currency?: string;
          "class-name"?: string;
          "custom-url"?: string;
        },
        HTMLElement
      >;
    }
  }
}
