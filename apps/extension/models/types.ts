import { platforms } from '@/models/constants';

export type IPlatforms = typeof platforms;
export type IPlatform = IPlatforms[number];
