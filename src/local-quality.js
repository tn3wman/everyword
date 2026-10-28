import {qualityProvider} from './quality-provider.js';
import {modelRuntime,modelParallelism,QUALITY_MODEL} from './model-runtime.js';

const names={en:'English',es:'Spanish',fr:'French',ar:'Arabic',ja:'Japanese',zh:'Chinese','zh-Hant':'Traditional Chinese',pt:'Portuguese',tr:'Turkish',ru:'Russian',ko:'Korean',th:'Thai',it:'Italian',de:'German',vi:'Vietnamese',ms:'Malay',id:'Indonesian',fil:'Filipino',hi:'Hindi',pl:'Polish',cs:'Czech',nl:'Dutch',km:'Khmer',my:'Burmese',fa:'Persian',gu:'Gujarati',ur:'Urdu',te:'Telugu',mr:'Marathi',he:'Hebrew',bn:'Bengali',ta:'Tamil',uk:'Ukrainian',bo:'Tibetan',kk:'Kazakh',mn:'Mongolian',ug:'Uyghur',yue:'Cantonese'};

export function localQualityProvider({baseURL}={}){
  const runtime=modelRuntime({baseURL});
  const inference=qualityProvider({baseURL:runtime.endpoint,concurrency:modelParallelism()});
  const languages=Object.entries(names).map(([code,name])=>({code,name}));
  return {
    type:'local',name:QUALITY_MODEL.name,
    cacheKey:inference.cacheKey,
    translate:inference.translate,
    start:runtime.start,
    endpoint:runtime.endpoint,
    async warm(){await runtime.start();},
    status(){const status=runtime.status();return {...status,languages,loaded:status.ready?languages.map(({code})=>({source:'en',target:code})):[]};},
    close:runtime.close
  };
}
