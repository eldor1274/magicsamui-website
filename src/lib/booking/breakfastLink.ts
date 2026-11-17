// The rate rows' link to the breakfast card on the booking page (owner, 16 Nov 2026). A rate row only says
// "Room only. ..." while the card "Breakfast at the villa - on request" sits under the whole room list, so each
// row gets a short link that scrolls to the card and moves focus to it (results/RoomOfferCard.tsx). The heading's
// id and the link's words live here, in one place, for the card, the link and the tests.

/** id of the breakfast card's heading on the booking page: the rate rows' link scrolls to it and focuses it. */
export const BREAKFAST_CARD_HEADING_ID = "breakfast-card-title";

/** The link's words. No price here: the card states it (BreakfastCard's BREAKFAST_PRICE_TEXT). */
export const BREAKFAST_LINK_LABEL = "Breakfast on request: see details";
