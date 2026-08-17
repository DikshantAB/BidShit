import { prebidDemandRules } from './prebid-demand';
import { prebidLifecycleRules } from './prebid-lifecycle';
import { prebidRenderRules } from './prebid-render';
import type { Rule } from '../types';

export const prebidRules: Rule[] = [...prebidLifecycleRules, ...prebidDemandRules, ...prebidRenderRules];
