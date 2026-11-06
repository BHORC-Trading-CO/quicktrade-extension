import { IPlatform } from '@/models/types';

export type IUsers_data = {
  [key in IPlatform]?: IUser_data;
};

export interface IUser_data {
  isAuthorized?: boolean;
  steamId?: string;
  email?: string;
  balance?: number;
}
