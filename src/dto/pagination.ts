export interface Paginated<T> {
  items: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export function paginate<T>(items: T[], page: number, pageSize: number, totalItems: number): Paginated<T> {
  return {
    items,
    pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
  };
}
