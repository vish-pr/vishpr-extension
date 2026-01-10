/**
 * Content script action types
 * Shared constants for communication between background and content scripts
 */
export const ContentAction = {
  EXTRACT_CONTENT: 'extractContent',
  CLICK_ELEMENT: 'clickElement',
  HIGHLIGHT_ELEMENT: 'highlightElement',
  FILL_FORM: 'fillForm',
  SCROLL_AND_WAIT: 'scrollAndWait',
  FIND_ELEMENTS: 'findElements',
  MULTI_ACTION: 'multiAction'
};
