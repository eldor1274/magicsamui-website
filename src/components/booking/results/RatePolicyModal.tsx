"use client";

// OWNER: ui-search-results
// Rate plan details: "{Room} ({Plan})", the plan photo, what it includes and
// its policy as real headings and paragraphs (Cloudbeds shows the owner's
// Markdown raw - we never do), plus the stay's cancellation terms.
// Keep RatePolicyModalProps stable.

import Image from "next/image";
import { HOUSE_POLICIES } from "@/lib/booking/catalogue";
import { formatThb } from "@/lib/booking/format";
import type { CatalogueRoom, RatePlanInfo } from "@/lib/booking/types";
import Modal from "../ui/Modal";

export interface RatePolicyModalProps {
  room: CatalogueRoom;
  ratePlan: RatePlanInfo;
  open: boolean;
  onClose: () => void;
}

export default function RatePolicyModal({ room, ratePlan, open, onClose }: RatePolicyModalProps) {
  const supplement = ratePlan.supplementSatangPerGuestPerNight;

  return (
    <Modal open={open} onClose={onClose} title={`${room.name} (${ratePlan.name})`} size="md">
      <div className="space-y-5">
        {ratePlan.image && (
          <div className="relative aspect-[16/9] overflow-hidden rounded-(--bk-radius-control) bg-(--bk-surface-sunken)">
            <Image src={ratePlan.image.src} alt={ratePlan.image.alt} fill sizes="(min-width: 640px) 464px, 100vw" className="object-cover" />
          </div>
        )}

        <div>
          <p className="leading-relaxed text-(--bk-text-muted)">{ratePlan.shortDescription}</p>
          {supplement > 0 && (
            <p className="mt-2 text-sm">
              <span className="bk-price font-semibold">{formatThb(supplement)}</span>{" "}
              <span className="text-(--bk-text-muted)">THB per guest per night, included in the price shown.</span>
            </p>
          )}
        </div>

        {ratePlan.policy.length > 0 && (
          <section aria-labelledby="rate-policy-heading" className="border-t border-(--bk-border) pt-5">
            <h3 id="rate-policy-heading" className="bk-heading text-lg">
              Policy
            </h3>
            <div className="mt-3 space-y-4">
              {ratePlan.policy.map((section) => (
                <div key={section.heading}>
                  <h4 className="text-sm font-semibold">{section.heading}</h4>
                  <p className="mt-1 text-sm leading-relaxed text-(--bk-text-muted)">{section.body}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section aria-labelledby="rate-cancel-heading" className="border-t border-(--bk-border) pt-5">
          <h3 id="rate-cancel-heading" className="text-sm font-semibold">
            Cancellation
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-(--bk-text-muted)">{HOUSE_POLICIES.cancellation}</p>
          <p className="mt-2 text-sm text-(--bk-text-muted)">
            {HOUSE_POLICIES.checkIn} · {HOUSE_POLICIES.checkOut}
          </p>
        </section>
      </div>
    </Modal>
  );
}
