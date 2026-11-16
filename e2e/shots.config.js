// README screenshots only (scripts/screenshots.sh). Kept apart from playwright.config.js so e2e.sh never runs them.
import base from './playwright.config.js';
export default { ...base, testMatch: 'readme.shots.js', use: { ...base.use, viewport: { width: 1440, height: 860 } } };
