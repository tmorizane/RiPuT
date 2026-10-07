# RiPuT
RiPuT is a web tool to do the primary screening of titles and abstracts of literature for systematic reviews. 
URL: https://stat.zanet.biz/sr/riput2.1.htm
### Feeding literature toRiPuT
The downloaded files of PubMed format or RIS format one obtain from medical literature databases, PubMed, Cochrane CENTRAL, Ichushi, Embase, and others are fed and the literature tables are created.  
### Setting API keys
You need to obtain a Google Gemini API key at the Google AI Studio (https://aistudio.google.com/) and set it at API settings of RiPuT.
Set Gemini AI models, one for adapting the eligibility criteria for the optimized eligibility criteria (gemini-3.1-pro-preview) and the other for AI screening of literature (gemini-3.8-flash). 
### Literature Screening
One can set the eligibility criteria and adapt them for the optimized eligibility criteria at the panel AI Screening (TIAB) which is shown by clicking Ask Gemini button. 

Write the inclusion criteria and the exclusion criteria (the original eligibility criteria).

Then click the button of ↓ Adapt for High Sensitivity Criteria to adapt the original eligibility criteria to make an optimized criteria for AI screening.

Then click Start Screening ↑ button at the bottom. 

The degree of eligibility is expressed one to five scores and dots in the table: 5=Definitely include, 4=Probably include, 3=Unsure/Needs full text, 2=Probably exclude, 1=Definitely exclude.

The time elapsed per 100 articles ranged from 3.3 to 12.4 seconds, with a median of 4.6 seconds.

When the screening is done, sort over the score by clicking Sort AI Score button. Then, chose articles with a score >= 3 for the full-text screening. By clicking Reference ID cell you can mark the article with cyan color and make a list of selected articles for the second screening with full texts.
