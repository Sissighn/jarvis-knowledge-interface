export type WeatherPayload = {
  location: string;
  updatedAt: string;
  current: {
    temperature: number;
    apparentTemperature: number;
    weatherCode: number;
    label: string;
    symbol: string;
    windSpeed: number;
  };
  today: {
    max: number;
    min: number;
    rainChance: number;
  };
  forecast: Array<{
    date: string;
    weatherCode: number;
    label: string;
    symbol: string;
    max: number;
    min: number;
    rainChance: number;
  }>;
  attribution: {
    label: "Open-Meteo";
    url: "https://open-meteo.com/";
  };
};
