// Page styles for the CSS Custom Highlight API. Highlights are painted by the browser from Range
// objects, so the page's DOM is never modified. Injected with chrome.scripting.insertCSS.
// The word gets dark text on a lamp-yellow background, readable on light and dark pages alike.

export const HIGHLIGHT_CSS = `
::highlight(narrata-sentence) { background-color: rgba(255, 199, 70, 0.2); }
::highlight(narrata-word) { background-color: #ffd25a; color: #15171c; }
`;
