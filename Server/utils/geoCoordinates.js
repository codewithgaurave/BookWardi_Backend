/**
 * Indian City and District GPS Coordinates Utility (Backend)
 */

export const INDIAN_CITY_COORDINATES = {
  'saharanpur': { lat: 29.9640, lng: 77.5460 },
  'behat': { lat: 30.1667, lng: 77.6167 },
  'deoband': { lat: 29.6958, lng: 77.6814 },
  'nakur': { lat: 29.9255, lng: 77.3072 },
  'gangoh': { lat: 29.7716, lng: 77.2588 },
  'rampur maniharan': { lat: 29.7997, lng: 77.5925 },
  'sarsawa': { lat: 29.9882, lng: 77.4069 },
  'muzaffarnagar': { lat: 29.4727, lng: 77.7085 },
  'shamli': { lat: 29.4485, lng: 77.3105 },
  'meerut': { lat: 28.9845, lng: 77.7064 },
  'baghpat': { lat: 28.9449, lng: 77.2244 },
  'baraut': { lat: 29.1026, lng: 77.2625 },
  'ghaziabad': { lat: 28.6692, lng: 77.4538 },
  'hapur': { lat: 28.7306, lng: 77.7759 },
  'noida': { lat: 28.5355, lng: 77.3910 },
  'greater noida': { lat: 28.4744, lng: 77.5040 },
  'gautam buddha nagar': { lat: 28.5355, lng: 77.3910 },
  'bulandshahr': { lat: 28.4069, lng: 77.8498 },
  'aligarh': { lat: 27.8974, lng: 78.0880 },
  'mathura': { lat: 27.4924, lng: 77.6737 },
  'vrindavan': { lat: 27.5806, lng: 77.7006 },
  'agra': { lat: 27.1767, lng: 78.0081 },
  'firozabad': { lat: 27.1592, lng: 78.3957 },
  'mainpuri': { lat: 27.2289, lng: 79.0253 },
  'etawah': { lat: 26.7855, lng: 79.0154 },
  'kanpur': { lat: 26.4499, lng: 80.3319 },
  'kanpur nagar': { lat: 26.4499, lng: 80.3319 },
  'kanpur dehat': { lat: 26.3687, lng: 79.9535 },
  'lucknow': { lat: 26.8467, lng: 80.9462 },
  'unnao': { lat: 26.5459, lng: 80.4878 },
  'raebareli': { lat: 26.2236, lng: 81.2409 },
  'amethi': { lat: 26.1557, lng: 81.8159 },
  'sultanpur': { lat: 26.2648, lng: 82.0727 },
  'ayodhya': { lat: 26.7922, lng: 82.1998 },
  'faizabad': { lat: 26.7731, lng: 82.1460 },
  'barabanki': { lat: 26.9269, lng: 81.1834 },
  'sitapur': { lat: 27.5684, lng: 80.6806 },
  'hardoi': { lat: 27.3989, lng: 80.1309 },
  'bareilly': { lat: 28.3670, lng: 79.4304 },
  'moradabad': { lat: 28.8386, lng: 78.7733 },
  'rampur': { lat: 28.8074, lng: 79.0267 },
  'bijnor': { lat: 29.3732, lng: 78.1354 },
  'varanasi': { lat: 25.3176, lng: 82.9739 },
  'banaras': { lat: 25.3176, lng: 82.9739 },
  'kashi': { lat: 25.3176, lng: 82.9739 },
  'mirzapur': { lat: 25.1337, lng: 82.5644 },
  'prayagraj': { lat: 25.4358, lng: 81.8463 },
  'allahabad': { lat: 25.4358, lng: 81.8463 },
  'gorakhpur': { lat: 26.7606, lng: 83.3732 },
  'azamgarh': { lat: 26.0682, lng: 83.1844 },
  'jhansi': { lat: 25.4484, lng: 78.5685 },
  'dehradun': { lat: 30.3165, lng: 78.0322 },
  'haridwar': { lat: 29.9457, lng: 78.1642 },
  'roorkee': { lat: 29.8543, lng: 77.8880 },
  'delhi': { lat: 28.6139, lng: 77.2090 },
  'new delhi': { lat: 28.6139, lng: 77.2090 },
  'gurgaon': { lat: 28.4595, lng: 77.0266 },
  'gurugram': { lat: 28.4595, lng: 77.0266 },
  'faridabad': { lat: 28.4089, lng: 77.3178 },
  'chandigarh': { lat: 30.7333, lng: 76.7794 },
  'jaipur': { lat: 26.9124, lng: 75.7873 },
  'patna': { lat: 25.5941, lng: 85.1376 }
};

export function resolveCityCoordinates(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.toLowerCase().trim().replace(/[^a-z0-9\s]/g, ' ');
  const stripped = clean.replace(/\s+/g, ' ').trim();
  if (INDIAN_CITY_COORDINATES[stripped]) {
    return INDIAN_CITY_COORDINATES[stripped];
  }
  const keysSorted = Object.keys(INDIAN_CITY_COORDINATES).sort((a, b) => b.length - a.length);
  for (const key of keysSorted) {
    const regex = new RegExp(`\\b${key}\\b`, 'i');
    if (regex.test(clean)) {
      return INDIAN_CITY_COORDINATES[key];
    }
  }
  for (const key of keysSorted) {
    if (clean.includes(key)) {
      return INDIAN_CITY_COORDINATES[key];
    }
  }
  return null;
}

