/**
 * The spend types the AI names for a purchase (the owner's D27, its list approved
 * 2026-10-11), and the category setting each one maps to. `other` has no setting: it, a
 * type whose setting is left empty, and a type the two reads dispute all use the default
 * category, the `expenseAccount` setting.
 */
export const SPEND_TYPES = [
  'meals',
  'travel',
  'vehicle_and_fuel',
  'office_supplies',
  'software_and_subscriptions',
  'utilities_and_phone',
  'rent',
  'repairs_and_maintenance',
  'professional_services',
  'materials',
  'advertising',
  'other',
] as const;
export type SpendType = (typeof SPEND_TYPES)[number];

export interface CategorySetting {
  readonly spendType: Exclude<SpendType, 'other'>;
  /** The flow's setting, camelCase as the manifest needs. */
  readonly key: string;
  /** As the setting is titled, and named in a sentence. */
  readonly title: string;
}

/** One optional "Category for <spend type>" setting per spend type but `other`, in the list's order. */
export const CATEGORY_SETTINGS: readonly CategorySetting[] = [
  category('meals', 'categoryMeals', 'meals'),
  category('travel', 'categoryTravel', 'travel'),
  category('vehicle_and_fuel', 'categoryVehicleAndFuel', 'vehicle and fuel'),
  category('office_supplies', 'categoryOfficeSupplies', 'office supplies'),
  category(
    'software_and_subscriptions',
    'categorySoftwareAndSubscriptions',
    'software and subscriptions',
  ),
  category('utilities_and_phone', 'categoryUtilitiesAndPhone', 'utilities and phone'),
  category('rent', 'categoryRent', 'rent'),
  category('repairs_and_maintenance', 'categoryRepairsAndMaintenance', 'repairs and maintenance'),
  category('professional_services', 'categoryProfessionalServices', 'professional services'),
  category('materials', 'categoryMaterials', 'materials'),
  category('advertising', 'categoryAdvertising', 'advertising'),
];

function category(spendType: CategorySetting['spendType'], key: string, words: string) {
  return { spendType, key, title: `Category for ${words}` };
}
