import { inject } from "vue";

export const HOME_DATABASE_FAVORITES_CONTEXT = Symbol("home-database-favorites");

export function useHomeDatabaseFavoritesContext() {
  return inject(HOME_DATABASE_FAVORITES_CONTEXT, null);
}
