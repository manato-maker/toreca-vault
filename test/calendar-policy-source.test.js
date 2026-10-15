import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');

test('calendar supports multiple result waves and hides invalid purchase deadlines',()=>{
 assert.match(source,/calendarResultDates_/);
 assert.match(source,/resultDates\.forEach/);
 assert.match(source,/calendarReceiptVisible_/);
 assert.match(source,/status==='落選'/);
 assert.match(source,/finalResult===false/);
 assert.match(source,/calendarNeedsReview_/);
});
