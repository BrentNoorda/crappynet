python -tt tools/jslint.py --allnew ./jslint_crappynet.allnew_marker

if [ "$?" -ne "0" ]; then
    echo "SORRY. JSLINT IS NOT HAPPY"
    exit 1
fi

#node debug ~/crappynet/crappynet.js 9090 8080 ~/.Trash/crappynet_settings.json
node src/server/crappynet.js 9090 8080 ./crappynet_settings.json
#node console.js
#node crappynet.js
#node preferences-9.js
