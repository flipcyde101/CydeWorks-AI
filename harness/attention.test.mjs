import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionFor} from './attention.mjs';

test('one task produces one attention entry containing every reason',()=>{
  const task={id:'one',title:'Synthetic task',status:'failed',attempts:[{provider:'opencode'}]};
  const item=attentionFor(task);
  assert.equal(item.id,'one');
  assert.deepEqual(item.reasons,['Run failed','Earlier outcome needs recovery']);
  assert.equal(attentionFor({id:'two',status:'accepted',attempts:[]}),null);
  const review=attentionFor({id:'three',title:'Synthetic review',status:'review',attempts:[{checks:[{pass:false}]}]});
  assert.deepEqual(review.reasons,['Proposal needs review','A check failed']);
});
